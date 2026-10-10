// window.__XRB_HOST__: what the page needs synchronously at start-up.
//
//   {
//     version: 1,
//     stereo: true,                       // false on a mono display (desktop) and in the 2D view
//     display: { widthM, heightM, tiltRad, pixelsW, pixelsH },
//     eye: { width, height },             // per-eye render size in CSS px (page is 2*width wide when stereo)
//     channel: { url },                   // ws://127.0.0.1:<port>/?token=<token>
//     platform: { name, params: {} },     // station runtime ("" standalone); params arrive on the channel (kPlatform)
//     hostNow(): number                   // host clock (QPC) in ms, the clock of every channel timestamp
//   }
//
// Built in the browser process as a CefDictionaryValue (CreateBrowser extra_info)
// and turned into read-only V8 objects in the renderer.
#include "cef_client.h"
#include "host_channel.h"

namespace {

class HostNowHandler : public CefV8Handler {
 public:
  bool Execute(const CefString&, CefRefPtr<CefV8Value>, const CefV8ValueList&, CefRefPtr<CefV8Value>& retval,
               CefString&) override {
    retval = CefV8Value::CreateDouble(channel::hostTimeMs());
    return true;
  }
  IMPLEMENT_REFCOUNTING(HostNowHandler);
};

constexpr auto kFrozen = static_cast<cef_v8_propertyattribute_t>(V8_PROPERTY_ATTRIBUTE_READONLY | V8_PROPERTY_ATTRIBUTE_DONTDELETE);

CefRefPtr<CefV8Value> toV8(CefRefPtr<CefDictionaryValue> dict) {
  CefRefPtr<CefV8Value> obj = CefV8Value::CreateObject(nullptr, nullptr);
  CefDictionaryValue::KeyList keys;
  dict->GetKeys(keys);
  for (const CefString& k : keys) {
    CefRefPtr<CefV8Value> v;
    switch (dict->GetType(k)) {
      case VTYPE_BOOL: v = CefV8Value::CreateBool(dict->GetBool(k)); break;
      case VTYPE_INT: v = CefV8Value::CreateInt(dict->GetInt(k)); break;
      case VTYPE_DOUBLE: v = CefV8Value::CreateDouble(dict->GetDouble(k)); break;
      case VTYPE_STRING: v = CefV8Value::CreateString(dict->GetString(k)); break;
      case VTYPE_DICTIONARY: v = toV8(dict->GetDictionary(k)); break;
      default: continue;
    }
    obj->SetValue(k, v, kFrozen);
  }
  return obj;
}

}  // namespace

void HostRenderer::OnContextCreated(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, CefRefPtr<CefV8Context> context) {
  if (!info_ || !frame->IsMain()) return;
  CefRefPtr<CefV8Value> host = toV8(info_);
  host->SetValue("hostNow", CefV8Value::CreateFunction("hostNow", new HostNowHandler), kFrozen);
  context->GetGlobal()->SetValue("__XRB_HOST__", host, kFrozen);
}
