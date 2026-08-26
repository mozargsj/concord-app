// Captures Windows system-audio loopback while excluding a specific process (and its child
// processes) from the mix, via the WASAPI "process loopback" activation path documented at
// https://learn.microsoft.com/en-us/windows/win32/coreaudio/process-loopback-recording
// (Windows 10 2004+). Used to exclude Concord's own process from the loopback captured for
// screen-share system audio, so remote peers' voices — which Concord itself is playing back
// through the sharer's speakers — never get folded back into the outgoing screen-audio track.
//
// Adapted from Microsoft's own reference sample (microsoft/Windows-classic-samples,
// Samples/ApplicationLoopback), swapping its WRL/wil/Media-Foundation plumbing for a plain
// std::thread + raw COM (no extra dependencies) and N-API delivery instead of writing a WAV file.

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

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

std::atomic<bool> g_isCapturing{false};
HANDLE g_stopEvent = nullptr;

void CaptureThreadMain(DWORD excludePid, Napi::ThreadSafeFunction tsfn) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool needsCoUninit = SUCCEEDED(hr);

  auto fail = [&](const std::string& msg, ActivationHandler* handler, IAudioClient* audioClient,
                   IAudioCaptureClient* captureClient, HANDLE sampleEvent) {
    tsfn.NonBlockingCall(new CaptureEvent{EventType::Error, msg}, DeliverEvent);
    if (captureClient) captureClient->Release();
    if (sampleEvent) CloseHandle(sampleEvent);
    if (audioClient) audioClient->Release();
    if (handler) handler->Release();
    if (needsCoUninit) CoUninitialize();
    tsfn.Release();
    g_isCapturing.store(false);
  };

  ActivationHandler* handler = new ActivationHandler();
  handler->AddRef();

  AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
  activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activationParams.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  activationParams.ProcessLoopbackParams.TargetProcessId = excludePid;

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
    fail("process-loopback activation rejected (Windows version too old, or unsupported)", handler, nullptr, nullptr,
         nullptr);
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

  UINT32 engineBufferFrames = 0;
  audioClient->GetBufferSize(&engineBufferFrames);

  tsfn.NonBlockingCall(new CaptureEvent{EventType::Started}, DeliverEvent);

  int wakeUps = 0, timeouts = 0, packetsWithData = 0, getBufferFailures = 0, otherWait = 0;

  HANDLE waitHandles[2] = {sampleEvent, g_stopEvent};
  bool keepRunning = true;
  while (keepRunning) {
    DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, 2000);
    if (waitResult == WAIT_OBJECT_0 + 1) break;  // stop requested
    if (waitResult == WAIT_TIMEOUT) {
      timeouts++;
      continue;
    }
    if (waitResult != WAIT_OBJECT_0) {
      otherWait++;
      break;  // WAIT_FAILED / WAIT_ABANDONED — bail out rather than spin
    }
    wakeUps++;

    UINT32 packetLength = 0;
    while (SUCCEEDED(captureClient->GetNextPacketSize(&packetLength)) && packetLength > 0) {
      BYTE* data = nullptr;
      UINT32 framesAvailable = 0;
      DWORD flags = 0;
      hr = captureClient->GetBuffer(&data, &framesAvailable, &flags, nullptr, nullptr);
      if (FAILED(hr)) {
        getBufferFailures++;
        break;
      }
      packetsWithData++;

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
  CloseHandle(sampleEvent);
  audioClient->Release();
  if (needsCoUninit) CoUninitialize();

  {
    char diag[256];
    snprintf(diag, sizeof(diag),
             "engineBufferFrames=%u wakeUps=%d timeouts=%d packetsWithData=%d getBufferFailures=%d otherWait=%d",
             engineBufferFrames, wakeUps, timeouts, packetsWithData, getBufferFailures, otherWait);
    CaptureEvent* diagEvent = new CaptureEvent{EventType::Error, std::string("DIAG: ") + diag};
    tsfn.NonBlockingCall(diagEvent, DeliverEvent);
  }

  tsfn.NonBlockingCall(new CaptureEvent{EventType::Stopped}, DeliverEvent);
  tsfn.Release();
  g_isCapturing.store(false);
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_isCapturing.load()) {
    Napi::Error::New(env, "already capturing").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "expected (excludePid: number, onEvent: function)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  DWORD excludePid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());
  Napi::Function callback = info[1].As<Napi::Function>();

  if (!g_stopEvent) g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  ResetEvent(g_stopEvent);

  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, callback, "ProcessLoopbackCapture", 0, 1);

  g_isCapturing.store(true);
  std::thread(CaptureThreadMain, excludePid, tsfn).detach();

  return Napi::Boolean::New(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  if (g_stopEvent) SetEvent(g_stopEvent);
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  return exports;
}

}  // namespace

NODE_API_MODULE(process_loopback, Init)
