// Providers built into the core: they need no device and no vendor runtime.
//   display desktop  a window (or full screen on a monitor), mono, a fixed viewer
//   input   none     no hands
// (replay and simulated inputs: builtin_inputs.cpp)
#include <windows.h>

#include "json_util.h"

#include "providers.h"

namespace providers {

std::vector<BuiltinEntry> builtinInputs();    // builtin_inputs.cpp

namespace {

struct Desktop {
  const XrbHost* host;
  nlohmann::json cfg;
};

bool monitorRect(int index, RECT* out) {
  struct Find {
    int want, at = 0;
    RECT r{};
    bool found = false;
  } f{index};
  if (index <= 0) {
    MONITORINFO mi{sizeof(mi)};
    if (!GetMonitorInfoW(MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY), &mi)) return false;
    *out = mi.rcMonitor;
    return true;
  }
  EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR, HDC, LPRECT r, LPARAM p) -> BOOL {
    auto* f = (Find*)p;
    if (f->at++ == f->want) { f->r = *r; f->found = true; return FALSE; }
    return TRUE;
  }, (LPARAM)&f);
  if (f.found) *out = f.r;
  return f.found;
}

const char* XRB_CALL noError(void*) { return ""; }

int32_t XRB_CALL desktopOpen(void* self, XrbDisplayInfo* info) {
  auto* d = (Desktop*)self;
  // Default geometry: a 27-inch 16:9 panel leaning back 45 degrees, the one the SDK's emulation was tuned on.
  info->width_m = jsonOr(d->cfg, "widthM", 0.596736f);
  info->height_m = jsonOr(d->cfg, "heightM", 0.335664f);
  info->tilt_rad = jsonOr(d->cfg, "tiltRad", 0.785398f);
  info->layout = XRB_LAYOUT_MONO;
  info->presentation = XRB_PRESENT_WINDOW;
  if (jsonOr(d->cfg, "fullscreen", false)) {
    RECT r{};
    const int monitor = jsonOr(d->cfg, "monitor", 0);
    if (!monitorRect(monitor, &r)) {
      d->host->log(d->host->ctx, XRB_LOG_WARN, ("monitor " + std::to_string(monitor) + " not found, using the primary").c_str());
      monitorRect(0, &r);
    }
    info->has_monitor = 1;
    info->monitor_left = r.left, info->monitor_top = r.top, info->monitor_right = r.right, info->monitor_bottom = r.bottom;
    info->fullscreen = 1;
  }
  return 0;
}
int32_t XRB_CALL desktopStart(void*, int32_t, XrbDisplayInfo*) { return 0; }
void XRB_CALL desktopEyes(void*, XrbEyes* eyes) {
  // A viewer 0.6 m in front of the panel centre, eyes 63 mm apart: always valid.
  eyes->left[0] = -0.0315f, eyes->left[1] = 0, eyes->left[2] = 0.6f;
  eyes->right[0] = 0.0315f, eyes->right[1] = 0, eyes->right[2] = 0.6f;
  eyes->stale = 0;
}
int32_t XRB_CALL desktopSetStereo(void*, int32_t on) { return on ? 1 : 0; }
uint32_t XRB_CALL desktopBeginExit(void*) { return 0; }
uint32_t XRB_CALL desktopEnd(void*) { return 0; }
void XRB_CALL desktopDestroy(void* self) { delete (Desktop*)self; }
const XrbDisplayApi kDesktop = {sizeof(XrbDisplayApi), noError, desktopOpen, desktopStart, desktopEyes, desktopSetStereo,
                                desktopBeginExit, desktopEnd, desktopDestroy};
void* XRB_CALL createDesktop(const XrbHost* host, const char* config, const XrbDisplayApi** api) {
  *api = &kDesktop;
  nlohmann::json cfg = nlohmann::json::parse(config ? config : "{}", nullptr, false);
  return new Desktop{host, cfg.is_object() ? cfg : nlohmann::json::object()};
}

int32_t XRB_CALL noneStart(void*) { return 0; }
void XRB_CALL noneStop(void*) {}
void XRB_CALL noneDestroy(void*) {}
const XrbInputApi kNone = {sizeof(XrbInputApi), noError, noneStart, noneStop, noneDestroy};
int gNoneHandle;
void* XRB_CALL createNone(const XrbHost*, const char*, const XrbInputApi** api) {
  *api = &kNone;
  return &gNoneHandle;
}

}  // namespace

const std::vector<BuiltinEntry>& builtinRegistry() {
  static const std::vector<BuiltinEntry> all = [] {
    std::vector<BuiltinEntry> r = {
        {XRB_ROLE_DISPLAY, "desktop", "a window or a full-screen monitor, mono, fixed viewer", (void*)&createDesktop},
        {XRB_ROLE_INPUT, "none", "no hands", (void*)&createNone},
    };
    for (const BuiltinEntry& e : builtinInputs()) r.push_back(e);
    return r;
  }();
  return all;
}

}  // namespace providers
