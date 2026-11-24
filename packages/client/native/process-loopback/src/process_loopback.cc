// Windows WASAPI "process loopback" capture — two uses:
//   (1) EXCLUDE mode: captures the whole system mix except one target process (and its
//       children). Used to strip Concord's own playback (every other participant's voice) out
//       of screen-share system audio, so remote peers never hear an echo of themselves.
//   (2) INCLUDE mode: captures only one target process (and its children). Used for "share this
//       app's audio" (2026-08-30, pedido do Mozar — a transmissão de tela já usava (1), esta
//       parte é o modo espelhado, mesma API do Windows, só o enum diferente). Also, one INCLUDE
//       capture per allowed app, summed in the renderer, when the user excludes apps from the
//       screen-share audio (2026-11-24) — the API takes a single target PID per capture, so
//       "everything except these N apps" can't be one EXCLUDE capture.
// https://learn.microsoft.com/en-us/windows/win32/coreaudio/process-loopback-recording
// (Windows 10 2004+). Also exposes ListAudioSessions(), enumerating processes with an active
// audio session — the source list for the "which app?" picker feeding INCLUDE-mode captures.
//
// Adapted from Microsoft's own reference sample (microsoft/Windows-classic-samples,
// Samples/ApplicationLoopback), swapping its WRL/wil/Media-Foundation plumbing for plain
// std::thread + raw COM (no extra dependencies) and N-API delivery instead of writing a WAV file.
//
// Multiple concurrent capture sessions are supported (2026-08-30) — a user can share screen
// system audio (EXCLUDE-self) and a specific app's audio (INCLUDE-one-app) at the same time, so
// the single global g_isCapturing/g_stopEvent this file used to have (one capture ever) became a
// map keyed by a caller-supplied sessionId string instead.

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <tlhelp32.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

// Minimal COM object implementing IActivateAudioInterfaceCompletionHandler by hand — avoids
// pulling in WRL/wil just for this one callback. IAgileObject is a marker interface (no
// methods of its own); answering it tells COM this object is safe to invoke from any
// apartment/thread without proxying, which ActivateAudioInterfaceAsync's worker thread needs.
class ActivationHandler : public IActivateAudioInterfaceCompletionHandler {
 public:
  ActivationHandler() { doneEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
  ~ActivationHandler() {
    if (doneEvent) CloseHandle(doneEvent);
  }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
    if (!ppvObject) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppvObject = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    if (riid == __uuidof(IAgileObject)) {
      *ppvObject = static_cast<IUnknown*>(this);
      AddRef();
      return S_OK;
    }
    *ppvObject = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refCount_); }

  ULONG STDMETHODCALLTYPE Release() override {
    LONG result = InterlockedDecrement(&refCount_);
    if (result == 0) delete this;
    return static_cast<ULONG>(result);
  }

  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activateResult = E_UNEXPECTED;
    IUnknown* audioInterface = nullptr;
    HRESULT hr = operation->GetActivateResult(&activateResult, &audioInterface);
    if (SUCCEEDED(hr)) hr = activateResult;
    if (SUCCEEDED(hr) && audioInterface) {
      hr = audioInterface->QueryInterface(IID_PPV_ARGS(&audioClient));
    }
    if (audioInterface) audioInterface->Release();
    result = hr;
    SetEvent(doneEvent);
    return S_OK;
  }

  HANDLE doneEvent = nullptr;
  HRESULT result = E_UNEXPECTED;
  IAudioClient* audioClient = nullptr;

 private:
  volatile LONG refCount_ = 1;
};

enum class EventType { Started, Error, Data, Stopped };

struct CaptureEvent {
  EventType type;
  std::string message;
  float* pcm = nullptr;
  size_t frameCount = 0;  // stereo frames (2 floats each)
};

void DeliverEvent(Napi::Env env, Napi::Function jsCallback, CaptureEvent* event) {
  if (env != nullptr && jsCallback != nullptr) {
    switch (event->type) {
      case EventType::Started:
        jsCallback.Call({Napi::String::New(env, "started")});
        break;
      case EventType::Error:
        jsCallback.Call({Napi::String::New(env, "error"), Napi::String::New(env, event->message)});
        break;
      case EventType::Data: {
        // Plain allocating New() + memcpy, deliberately not the external-pointer + finalizer
        // overload — that path threw a pending JS exception on every single call in testing
        // against this Electron/node-addon-api combination, for reasons not fully understood.
        // The extra copy is a few KB per ~10ms chunk — cheap — and this path is unambiguous.
        size_t sampleCount = event->frameCount * 2;
        Napi::Buffer<float> buffer = Napi::Buffer<float>::New(env, sampleCount);
        std::memcpy(buffer.Data(), event->pcm, sampleCount * sizeof(float));
        jsCallback.Call({Napi::String::New(env, "data"), buffer});
        break;
      }
      case EventType::Stopped:
        jsCallback.Call({Napi::String::New(env, "stopped")});
        break;
    }
  }
  if (event->pcm) delete[] event->pcm;
  delete event;
}

// One stop-event per active session (keyed by the caller-supplied sessionId), guarded by a
// mutex — replaces the old single global g_isCapturing/g_stopEvent so EXCLUDE-self (screen
// share) and INCLUDE-one-app (music share) can run at the same time without stepping on each
// other.
std::mutex g_sessionsMutex;
std::map<std::string, HANDLE> g_stopEvents;

void CaptureThreadMain(std::string sessionId, PROCESS_LOOPBACK_MODE mode, DWORD targetPid,
                        Napi::ThreadSafeFunction tsfn) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool needsCoUninit = SUCCEEDED(hr);

  HANDLE stopEvent;
  {
    std::lock_guard<std::mutex> lock(g_sessionsMutex);
    stopEvent = g_stopEvents[sessionId];
  }

  auto cleanupSession = [&]() {
    std::lock_guard<std::mutex> lock(g_sessionsMutex);
    auto it = g_stopEvents.find(sessionId);
    if (it != g_stopEvents.end()) {
      CloseHandle(it->second);
      g_stopEvents.erase(it);
    }
  };

  auto fail = [&](const std::string& msg, ActivationHandler* handler, IAudioClient* audioClient,
                   IAudioCaptureClient* captureClient, HANDLE sampleEvent) {
    tsfn.NonBlockingCall(new CaptureEvent{EventType::Error, msg}, DeliverEvent);
    if (captureClient) captureClient->Release();
    if (sampleEvent) CloseHandle(sampleEvent);
    if (audioClient) audioClient->Release();
    if (handler) handler->Release();
    if (needsCoUninit) CoUninitialize();
    tsfn.Release();
    cleanupSession();
  };

  ActivationHandler* handler = new ActivationHandler();
  handler->AddRef();

  AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
  activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activationParams.ProcessLoopbackParams.ProcessLoopbackMode = mode;
  activationParams.ProcessLoopbackParams.TargetProcessId = targetPid;

  PROPVARIANT activateParams = {};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(activationParams);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

  IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activateParams,
                                    handler, &asyncOp);
  if (FAILED(hr)) {
    if (asyncOp) asyncOp->Release();
    fail("ActivateAudioInterfaceAsync failed", handler, nullptr, nullptr, nullptr);
    return;
  }

  WaitForSingleObject(handler->doneEvent, INFINITE);
  if (asyncOp) asyncOp->Release();

  if (FAILED(handler->result) || !handler->audioClient) {
    fail("process-loopback activation rejected (Windows version too old, target process gone, or unsupported)",
         handler, nullptr, nullptr, nullptr);
    return;
  }

  IAudioClient* audioClient = handler->audioClient;
  audioClient->AddRef();
  handler->Release();
  handler = nullptr;

  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 32;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;

  hr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                                0, 0, &format, nullptr);
  if (FAILED(hr)) {
    fail("IAudioClient::Initialize failed", nullptr, audioClient, nullptr, nullptr);
    return;
  }

  HANDLE sampleEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = audioClient->SetEventHandle(sampleEvent);
  if (FAILED(hr)) {
    fail("SetEventHandle failed", nullptr, audioClient, nullptr, sampleEvent);
    return;
  }

  IAudioCaptureClient* captureClient = nullptr;
  hr = audioClient->GetService(IID_PPV_ARGS(&captureClient));
  if (FAILED(hr)) {
    fail("GetService(IAudioCaptureClient) failed", nullptr, audioClient, nullptr, sampleEvent);
    return;
  }

  hr = audioClient->Start();
  if (FAILED(hr)) {
    fail("IAudioClient::Start failed", nullptr, audioClient, captureClient, sampleEvent);
    return;
  }

  tsfn.NonBlockingCall(new CaptureEvent{EventType::Started}, DeliverEvent);

  HANDLE waitHandles[2] = {sampleEvent, stopEvent};
  bool keepRunning = true;
  while (keepRunning) {
    DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, 2000);
    if (waitResult == WAIT_OBJECT_0 + 1) break;  // stop requested
    if (waitResult == WAIT_TIMEOUT) continue;
    if (waitResult != WAIT_OBJECT_0) break;  // WAIT_FAILED / WAIT_ABANDONED — bail rather than spin

    UINT32 packetLength = 0;
    while (SUCCEEDED(captureClient->GetNextPacketSize(&packetLength)) && packetLength > 0) {
      BYTE* data = nullptr;
      UINT32 framesAvailable = 0;
      DWORD flags = 0;
      hr = captureClient->GetBuffer(&data, &framesAvailable, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;

      if (framesAvailable > 0) {
        size_t sampleCount = static_cast<size_t>(framesAvailable) * format.nChannels;
        float* pcmCopy = new float[sampleCount];
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          std::memset(pcmCopy, 0, sampleCount * sizeof(float));
        } else {
          std::memcpy(pcmCopy, data, sampleCount * sizeof(float));
        }
        CaptureEvent* dataEvent = new CaptureEvent{EventType::Data};
        dataEvent->pcm = pcmCopy;
        dataEvent->frameCount = framesAvailable;
        tsfn.NonBlockingCall(dataEvent, DeliverEvent);
      }

      captureClient->ReleaseBuffer(framesAvailable);
    }
  }

  audioClient->Stop();
  captureClient->Release();
  audioClient->Release();
  if (needsCoUninit) CoUninitialize();

  tsfn.NonBlockingCall(new CaptureEvent{EventType::Stopped}, DeliverEvent);
  tsfn.Release();
  cleanupSession();
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsString() || !info[1].IsString() || !info[2].IsNumber() ||
      !info[3].IsFunction()) {
    Napi::TypeError::New(env, "expected (sessionId: string, mode: 'exclude'|'include', targetPid: number, "
                               "onEvent: function)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  std::string modeStr = info[1].As<Napi::String>().Utf8Value();
  DWORD targetPid = static_cast<DWORD>(info[2].As<Napi::Number>().Uint32Value());
  Napi::Function callback = info[3].As<Napi::Function>();

  PROCESS_LOOPBACK_MODE mode = modeStr == "include" ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                                                      : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  {
    std::lock_guard<std::mutex> lock(g_sessionsMutex);
    if (g_stopEvents.count(sessionId)) {
      Napi::Error::New(env, "session already capturing").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    g_stopEvents[sessionId] = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  }

  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, callback, "ProcessLoopbackCapture", 0, 1);
  std::thread(CaptureThreadMain, sessionId, mode, targetPid, tsfn).detach();

  return Napi::Boolean::New(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "expected (sessionId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  std::lock_guard<std::mutex> lock(g_sessionsMutex);
  auto it = g_stopEvents.find(sessionId);
  if (it != g_stopEvents.end()) SetEvent(it->second);
  return env.Undefined();
}

// Correct UTF-16 -> UTF-8 conversion (WideCharToMultiByte, no extra dependency) — app display
// names/exe filenames aren't guaranteed ASCII (accents, non-Latin scripts), so a naive
// std::string(wide.begin(), wide.end()) narrowing cast would mangle anything outside ASCII.
std::string WideToUtf8(const std::wstring& wide) {
  if (wide.empty()) return std::string();
  int sizeNeeded = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), nullptr, 0, nullptr,
                                        nullptr);
  std::string result(sizeNeeded, 0);
  WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), result.data(), sizeNeeded, nullptr,
                       nullptr);
  return result;
}

// The exe's own filename with extension ("Spotify.exe"), empty if the process can't be opened —
// QueryFullProcessImageNameW + manual trim, avoids pulling in Psapi.lib for GetModuleBaseName.
// Stable across runs (a PID isn't), so it's what the screen-share "exclude these apps" list keys on.
std::wstring ExeFileNameForPid(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return std::wstring();
  WCHAR path[MAX_PATH] = {};
  DWORD size = MAX_PATH;
  std::wstring fileName;
  if (QueryFullProcessImageNameW(process, 0, path, &size)) {
    std::wstring full(path);
    size_t slash = full.find_last_of(L"\\/");
    fileName = slash == std::wstring::npos ? full : full.substr(slash + 1);
  }
  CloseHandle(process);
  return fileName;
}

// Friendly name for a PID — the session's own DisplayName when a well-behaved app set one
// (IAudioSessionControl::GetDisplayName), otherwise the exe's filename without extension.
std::wstring FriendlyNameForPid(DWORD pid, const std::wstring& sessionDisplayName, const std::wstring& exeFileName) {
  if (!sessionDisplayName.empty()) return sessionDisplayName;
  if (exeFileName.empty()) return L"Processo " + std::to_wstring(pid);
  size_t dot = exeFileName.find_last_of(L'.');
  return dot == std::wstring::npos ? exeFileName : exeFileName.substr(0, dot);
}

// Parent pid and exe filename of every running process (one Toolhelp snapshot). PROCESS_LOOPBACK
// captures a whole process TREE in both modes, so an INCLUDE capture takes everything below its
// target: the session list needs each session's ancestry (to keep Concord's own tree out, and to
// drop a child already covered by a captured parent) and its descendants' exes (so a capture never
// drags an excluded app running below it into the screen-share mix, even one silent right now).
// ponytail: parent pids can be stale (parent exited, pid reused) — that only ever makes the
// checks below drop more, never capture more.
struct ProcInfo {
  DWORD parent;
  std::wstring exe;
};

std::map<DWORD, ProcInfo> SnapshotProcesses() {
  std::map<DWORD, ProcInfo> processes;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return processes;
  PROCESSENTRY32W entry = {};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      processes[entry.th32ProcessID] = ProcInfo{entry.th32ParentProcessID, entry.szExeFile};
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return processes;
}

// Parent, grandparent, ... up to the root. Depth cap + self-check guard against parent-pid cycles
// that stale/reused pids can produce.
std::vector<DWORD> AncestorsOf(DWORD pid, const std::map<DWORD, ProcInfo>& processes) {
  std::vector<DWORD> ancestors;
  DWORD current = pid;
  for (int depth = 0; depth < 64; depth++) {
    auto it = processes.find(current);
    if (it == processes.end() || it->second.parent == 0 || it->second.parent == current || it->second.parent == pid)
      break;
    current = it->second.parent;
    ancestors.push_back(current);
  }
  return ancestors;
}

// Exe filenames of every process below `pid` (children, grandchildren, ...), whether or not they
// play anything. Visited set + cap guard against cycles from stale parent pids.
std::vector<std::wstring> DescendantExesOf(DWORD pid, const std::map<DWORD, ProcInfo>& processes) {
  std::vector<std::wstring> exes;
  std::vector<DWORD> pending{pid};
  std::vector<DWORD> visited{pid};
  while (!pending.empty() && visited.size() < 4096) {
    DWORD parent = pending.back();
    pending.pop_back();
    for (const auto& [childPid, info] : processes) {
      if (info.parent != parent || childPid == parent) continue;
      bool seen = false;
      for (DWORD v : visited) {
        if (v == childPid) {
          seen = true;
          break;
        }
      }
      if (seen) continue;
      visited.push_back(childPid);
      pending.push_back(childPid);
      exes.push_back(info.exe);
    }
  }
  return exes;
}

// Enumerates processes with an active WASAPI render session on the default output device — the
// source list for "which app's audio?" (INCLUDE-mode target picker). Synchronous: COM
// enumeration here is fast (sub-100ms in practice), and every caller in this addon so far is
// synchronous too (Start/Stop), so this stays consistent rather than adding AsyncWorker plumbing
// for one call.
Napi::Value ListAudioSessions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool needsCoUninit = SUCCEEDED(hr);
  // RPC_E_CHANGED_MODE means this thread already has COM initialized in a different apartment
  // model (fine, still usable) — anything else genuinely failing CoInitialize is unusual but not
  // fatal here either, the calls below will just fail gracefully and we return an empty list.

  IMMDeviceEnumerator* deviceEnumerator = nullptr;
  IMMDevice* device = nullptr;
  IAudioSessionManager2* sessionManager = nullptr;
  IAudioSessionEnumerator* sessionEnumerator = nullptr;

  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&deviceEnumerator));
  if (SUCCEEDED(hr)) hr = deviceEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (SUCCEEDED(hr)) hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                            reinterpret_cast<void**>(&sessionManager));
  if (SUCCEEDED(hr)) hr = sessionManager->GetSessionEnumerator(&sessionEnumerator);

  int written = 0;
  if (SUCCEEDED(hr)) {
    int sessionCount = 0;
    sessionEnumerator->GetCount(&sessionCount);
    DWORD selfPid = GetCurrentProcessId();
    std::vector<DWORD> seenPids;
    std::map<DWORD, ProcInfo> processes = SnapshotProcesses();
    // Processes ABOVE Concord (whoever launched it: explorer, the updater, a launcher). Their tree
    // contains Concord, so an INCLUDE capture of one would carry the call's voices too.
    std::vector<DWORD> selfAncestors = AncestorsOf(selfPid, processes);

    for (int i = 0; i < sessionCount; i++) {
      IAudioSessionControl* control = nullptr;
      if (FAILED(sessionEnumerator->GetSession(i, &control)) || !control) continue;

      IAudioSessionControl2* control2 = nullptr;
      if (SUCCEEDED(control->QueryInterface(IID_PPV_ARGS(&control2))) && control2) {
        DWORD pid = 0;
        control2->GetProcessId(&pid);
        AudioSessionState state = AudioSessionStateInactive;
        control->GetState(&state);

        bool alreadySeen = false;
        for (DWORD seen : seenPids) {
          if (seen == pid) {
            alreadySeen = true;
            break;
          }
        }

        std::vector<DWORD> ancestors = AncestorsOf(pid, processes);
        bool touchesConcordTree = false;
        for (DWORD ancestor : ancestors) {
          if (ancestor == selfPid) touchesConcordTree = true;
        }
        for (DWORD selfAncestor : selfAncestors) {
          if (selfAncestor == pid) touchesConcordTree = true;
        }

        // Skips: system-sounds pseudo-session, anything whose capture would contain Concord's
        // audio — its own tree (Chromium's audio service is a child process, it's what actually
        // plays everyone's voice) and the processes above it (an INCLUDE capture takes the whole
        // tree) — duplicate sessions from the same app (one process can open several), and
        // anything not actually active right now (expired/inactive sessions from an app that
        // already closed its stream).
        if (control2->IsSystemSoundsSession() != S_OK && pid != 0 && pid != selfPid && !touchesConcordTree &&
            !alreadySeen && state == AudioSessionStateActive) {
          LPWSTR rawDisplayName = nullptr;
          std::wstring displayName;
          if (SUCCEEDED(control->GetDisplayName(&rawDisplayName)) && rawDisplayName) {
            displayName = rawDisplayName;
            CoTaskMemFree(rawDisplayName);
          }
          // App-set display names are sometimes a literal resource reference (e.g.
          // "@%SystemRoot%\\System32\\...") instead of real text when the app didn't bother
          // localizing it for this call path — falling back to the exe name reads better than
          // showing that raw string to the user.
          if (!displayName.empty() && displayName[0] == L'@') displayName.clear();

          std::wstring exeFileName = ExeFileNameForPid(pid);
          std::wstring name = FriendlyNameForPid(pid, displayName, exeFileName);
          Napi::Array ancestorArray = Napi::Array::New(env, ancestors.size());
          for (size_t a = 0; a < ancestors.size(); a++) {
            ancestorArray[static_cast<uint32_t>(a)] = Napi::Number::New(env, static_cast<double>(ancestors[a]));
          }
          Napi::Object entry = Napi::Object::New(env);
          entry.Set("pid", Napi::Number::New(env, static_cast<double>(pid)));
          entry.Set("name", Napi::String::New(env, WideToUtf8(name)));
          entry.Set("exe", Napi::String::New(env, WideToUtf8(exeFileName)));
          entry.Set("ancestors", ancestorArray);
          std::vector<std::wstring> descendantExes = DescendantExesOf(pid, processes);
          Napi::Array descendantArray = Napi::Array::New(env, descendantExes.size());
          for (size_t d = 0; d < descendantExes.size(); d++) {
            descendantArray[static_cast<uint32_t>(d)] = Napi::String::New(env, WideToUtf8(descendantExes[d]));
          }
          entry.Set("descendantExes", descendantArray);
          result[static_cast<uint32_t>(written++)] = entry;
          seenPids.push_back(pid);
        }
        control2->Release();
      }
      control->Release();
    }
  }

  if (sessionEnumerator) sessionEnumerator->Release();
  if (sessionManager) sessionManager->Release();
  if (device) device->Release();
  if (deviceEnumerator) deviceEnumerator->Release();
  if (needsCoUninit) CoUninitialize();

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("listAudioSessions", Napi::Function::New(env, ListAudioSessions));
  return exports;
}

}  // namespace

NODE_API_MODULE(process_loopback, Init)
