// Remote-control input for Windows, two independent halves:
//   (1) Injection (controlled PC): SendInput by hardware scan code / absolute virtual-desktop
//       coordinates, so the controlled PC's own keyboard layout and DPI decide the result.
//   (2) Low-level keyboard hook (controller PC): WH_KEYBOARD_LL on its own thread with a message
//       loop. While "swallow" is on it reports every key to JS and stops the key from reaching the
//       local PC (Win, Alt+Tab... that the renderer never sees). Ctrl+Shift+Pause is never
//       swallowed and is reported as an exit request - it is the user's way out. With swallow off
//       it only watches for that combination (the controlled PC's emergency stop).
// SendInput cannot reach elevated windows or the secure desktop (UIPI) - a documented limit of
// the MVP, see the spec (section 20 and the injector decision).

#include <napi.h>

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <thread>
#include <vector>

namespace {

bool SendKeyboard(WORD scan, bool extended, bool down) {
  INPUT in = {};
  in.type = INPUT_KEYBOARD;
  in.ki.wScan = scan;
  in.ki.dwFlags = KEYEVENTF_SCANCODE | (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP);
  return SendInput(1, &in, sizeof(INPUT)) == 1;
}

bool SendMouse(DWORD flags, LONG dx, LONG dy, DWORD data) {
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.dx = dx;
  in.mi.dy = dy;
  in.mi.mouseData = data;
  in.mi.dwFlags = flags;
  return SendInput(1, &in, sizeof(INPUT)) == 1;
}

// sendKey(scanCode, extended, down)
Napi::Value SendKey(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) return Napi::Boolean::New(env, false);
  return Napi::Boolean::New(
      env, SendKeyboard(static_cast<WORD>(info[0].As<Napi::Number>().Uint32Value()), info[1].As<Napi::Boolean>().Value(),
                        info[2].As<Napi::Boolean>().Value()));
}

// sendMouseAbs(x, y) - both 0..65535 across the whole virtual desktop.
Napi::Value SendMouseAbs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) return Napi::Boolean::New(env, false);
  LONG x = info[0].As<Napi::Number>().Int32Value();
  LONG y = info[1].As<Napi::Number>().Int32Value();
  return Napi::Boolean::New(env, SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y, 0));
}

// sendMouseButton(button, down) - 0 left, 1 right, 2 middle, 3 x1, 4 x2
Napi::Value SendMouseButton(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) return Napi::Boolean::New(env, false);
  uint32_t button = info[0].As<Napi::Number>().Uint32Value();
  bool down = info[1].As<Napi::Boolean>().Value();
  DWORD flags = 0;
  DWORD data = 0;
  switch (button) {
    case 0: flags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
    case 1: flags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
    case 2: flags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
    case 3: flags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP; data = XBUTTON1; break;
    case 4: flags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP; data = XBUTTON2; break;
    default: return Napi::Boolean::New(env, false);
  }
  return Napi::Boolean::New(env, SendMouse(flags, 0, 0, data));
}

// sendWheel(delta, horizontal) - delta in WHEEL_DELTA units (120 = one notch)
Napi::Value SendWheel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) return Napi::Boolean::New(env, false);
  LONG delta = info[0].As<Napi::Number>().Int32Value();
  bool horizontal = info[1].As<Napi::Boolean>().Value();
  return Napi::Boolean::New(env, SendMouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, 0, 0, static_cast<DWORD>(delta)));
}

// ---- local device capabilities (functional only) --------------------------------------------------
// Aggregates what the physical keyboards/mice of THIS PC can produce, via the Raw Input device list.
// Deliberately coarse and anonymous: counts and flags only. RIDI_DEVICENAME (which embeds VID/PID)
// and every product/manufacturer/serial string are never read, so nothing here can identify, or be
// used to imitate, a particular piece of hardware (spec section 7).
Napi::Value GetInputCapabilities(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  UINT count = 0;
  GetRawInputDeviceList(nullptr, &count, sizeof(RAWINPUTDEVICELIST));
  std::vector<RAWINPUTDEVICELIST> list(count);
  if (count > 0 && GetRawInputDeviceList(list.data(), &count, sizeof(RAWINPUTDEVICELIST)) == static_cast<UINT>(-1)) list.clear();

  uint32_t mice = 0, mouseButtons = 0, keyboards = 0, keysTotal = 0, functionKeys = 0;
  // A PC exposes many keyboard-class collections (receivers, gamepads, macro pads...) with odd type
  // values, so the kind is picked by priority instead of taking a maximum: Japanese, Korean, then a
  // regular enhanced keyboard, else whatever came first.
  bool japanese = false, korean = false, enhanced = false;
  uint32_t otherType = 0;
  bool horizontalWheel = false;
  for (const RAWINPUTDEVICELIST& device : list) {
    RID_DEVICE_INFO details = {};
    details.cbSize = sizeof(RID_DEVICE_INFO);
    UINT size = sizeof(RID_DEVICE_INFO);
    if (GetRawInputDeviceInfoW(device.hDevice, RIDI_DEVICEINFO, &details, &size) == static_cast<UINT>(-1)) continue;
    if (device.dwType == RIM_TYPEMOUSE) {
      mice++;
      mouseButtons = std::max<uint32_t>(mouseButtons, details.mouse.dwNumberOfButtons);
      horizontalWheel = horizontalWheel || details.mouse.fHasHorizontalWheel;
    } else if (device.dwType == RIM_TYPEKEYBOARD) {
      keyboards++;
      keysTotal = std::max<uint32_t>(keysTotal, details.keyboard.dwNumberOfKeysTotal);
      functionKeys = std::max<uint32_t>(functionKeys, details.keyboard.dwNumberOfFunctionKeys);
      if (details.keyboard.dwType == 7) japanese = true;
      else if (details.keyboard.dwType == 8) korean = true;
      else if (details.keyboard.dwType == 4) enhanced = true;
      else if (otherType == 0) otherType = details.keyboard.dwType;
    }
  }

  Napi::Object mouse = Napi::Object::New(env);
  mouse.Set("count", Napi::Number::New(env, mice));
  mouse.Set("buttons", Napi::Number::New(env, mouseButtons));
  mouse.Set("horizontalWheel", Napi::Boolean::New(env, horizontalWheel));
  Napi::Object keyboard = Napi::Object::New(env);
  keyboard.Set("count", Napi::Number::New(env, keyboards));
  keyboard.Set("keysTotal", Napi::Number::New(env, keysTotal));
  keyboard.Set("functionKeys", Napi::Number::New(env, functionKeys));
  keyboard.Set("type", Napi::Number::New(env, japanese ? 7 : korean ? 8 : enhanced ? 4 : otherType));
  Napi::Object result = Napi::Object::New(env);
  result.Set("mouse", mouse);
  result.Set("keyboard", keyboard);
  return result;
}

// ---- low-level keyboard hook -----------------------------------------------------------------

struct KeyEvent {
  DWORD scan;
  bool extended;
  bool down;
  bool exitRequested;
};

std::thread g_thread;
std::atomic<bool> g_running{false};
std::atomic<bool> g_ready{false};
std::atomic<bool> g_swallow{false};
std::atomic<DWORD> g_threadId{0};
HHOOK g_hook = nullptr;
Napi::ThreadSafeFunction g_tsfn;
bool g_ctrl = false;
bool g_shift = false;

void Emit(KeyEvent* event) {
  if (g_tsfn.NonBlockingCall(event, [](Napi::Env env, Napi::Function cb, KeyEvent* e) {
        if (env != nullptr && cb != nullptr) {
          cb.Call({Napi::Number::New(env, e->scan), Napi::Boolean::New(env, e->extended), Napi::Boolean::New(env, e->down),
                   Napi::Boolean::New(env, e->exitRequested)});
        }
        delete e;
      }) != napi_ok) {
    delete event;
  }
}

LRESULT CALLBACK HookProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION) {
    const KBDLLHOOKSTRUCT* k = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
    const bool down = wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN;
    const bool up = wParam == WM_KEYUP || wParam == WM_SYSKEYUP;
    // Keys injected by software (including this addon's own SendInput) are never intercepted.
    if ((down || up) && !(k->flags & LLKHF_INJECTED)) {
      const bool extended = (k->flags & LLKHF_EXTENDED) != 0;
      if (k->vkCode == VK_LCONTROL || k->vkCode == VK_RCONTROL || k->vkCode == VK_CONTROL) g_ctrl = down;
      if (k->vkCode == VK_LSHIFT || k->vkCode == VK_RSHIFT || k->vkCode == VK_SHIFT) g_shift = down;
      // Ctrl+Pause reaches the hook as VK_CANCEL (Break) on most keyboards.
      const bool exitCombo = down && (k->vkCode == VK_PAUSE || k->vkCode == VK_CANCEL) && g_ctrl && g_shift;
      // NumLock-related fake Shift (E0 2A) - not a real key press, never forwarded or swallowed.
      const bool fakeShift = k->scanCode == 0x2A && extended;
      if (exitCombo) {
        Emit(new KeyEvent{k->scanCode, extended, true, true});
        return CallNextHookEx(g_hook, code, wParam, lParam);
      }
      if (g_swallow.load() && !fakeShift) {
        Emit(new KeyEvent{k->scanCode, extended, down, false});
        return 1;
      }
    }
  }
  return CallNextHookEx(g_hook, code, wParam, lParam);
}

void HookThread() {
  g_threadId = GetCurrentThreadId();
  g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, HookProc, GetModuleHandleW(nullptr), 0);
  g_ready = true;
  if (g_hook) {
    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    }
    UnhookWindowsHookEx(g_hook);
    g_hook = nullptr;
  }
}

// startHook(onKey(scan, extended, down, exitRequested), swallow) -> boolean
Napi::Value StartHook(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsFunction() || g_running.load()) return Napi::Boolean::New(env, false);
  g_swallow = info[1].As<Napi::Boolean>().Value();
  g_ctrl = false;
  g_shift = false;
  g_ready = false;
  g_tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "input-control-hook", 0, 1);
  g_tsfn.Unref(env);  // a live hook must never keep the process from exiting
  g_running = true;
  g_thread = std::thread(HookThread);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (!g_ready.load() && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if (g_hook == nullptr) {
    if (g_threadId.load() != 0) PostThreadMessageW(g_threadId.load(), WM_QUIT, 0, 0);
    if (g_thread.joinable()) g_thread.join();
    g_tsfn.Release();
    g_running = false;
    return Napi::Boolean::New(env, false);
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value SetSwallow(const Napi::CallbackInfo& info) {
  if (info.Length() >= 1) g_swallow = info[0].As<Napi::Boolean>().Value();
  return info.Env().Undefined();
}

Napi::Value StopHook(const Napi::CallbackInfo& info) {
  if (g_running.exchange(false)) {
    g_swallow = false;
    if (g_threadId.load() != 0) PostThreadMessageW(g_threadId.load(), WM_QUIT, 0, 0);
    if (g_thread.joinable()) g_thread.join();
    g_tsfn.Release();
  }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("sendKey", Napi::Function::New(env, SendKey));
  exports.Set("sendMouseAbs", Napi::Function::New(env, SendMouseAbs));
  exports.Set("sendMouseButton", Napi::Function::New(env, SendMouseButton));
  exports.Set("sendWheel", Napi::Function::New(env, SendWheel));
  exports.Set("startHook", Napi::Function::New(env, StartHook));
  exports.Set("setSwallow", Napi::Function::New(env, SetSwallow));
  exports.Set("stopHook", Napi::Function::New(env, StopHook));
  exports.Set("getInputCapabilities", Napi::Function::New(env, GetInputCapabilities));
  return exports;
}

}  // namespace

NODE_API_MODULE(input_control, Init)
