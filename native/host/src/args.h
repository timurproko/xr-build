#pragma once
#include <string>
#include <vector>

// Command line. Every option uses the --name=value form, so values that start
// with "--" or contain spaces survive elevated and agent launches.
struct HostArgs {
  std::string url;          // --url=        page to show (overrides --app-dir)
  std::wstring appDir;      // --app-dir=    folder served at https://app.local/
  std::string view = "3d";  // --view=3d|2d  with a session: start in 3D or in 2D (mono page, stereo off);
                            //   either way the view can be switched while the app runs (channel, panel)
  int eyeW = 0, eyeH = 0;   // --eye-res=WxH per-eye page resolution (default: panel resolution)
  int windowW = 1600, windowH = 900;  // --window=WxH size of the emulation window
  bool gpu = true;          // --gpu=0       Chromium software compositing (diagnostic)
  double exitAfter = 0;     // --exit-after=S  quit after S seconds (smoke tests)
  std::wstring recordHands;      // --record-hands=<file.hands>  record the HANDS/STATUS stream
  bool cameraView = false;       // --camera-view=on  stream the input provider's debug images (e.g. camera views) on the channel
  std::wstring capture;          // --capture=<file.png>  save the side-by-side frame once
  double captureAfter = 8;       // --capture-after=S
  std::string status;            // --status=stdout  "@channel <url>" once and "@status {json}" every second on stdout (tools)
  std::wstring icon;             // --icon=<file.png>  window/taskbar icon (default: <exe>\app-icon.png, else built-in)
  // --render-icon=<out.png>  render the app's own icon: hidden square view, desktop display, no input,
  // page opened with ?xrb-icon=<size> on a transparent background; saved when the page calls
  // iconReady() (SDK). --icon-size=N (default 512).
  std::wstring renderIcon;
  int iconSize = 512;
  // Providers, one per role (built in or plugin). Empty: from the config file (--config=, else <exe>\xrb-app.json),
  // else none, desktop and no platform.
  std::string input;            // --input=     hands: none, replay, simulated, or an input plugin
  std::string display;          // --display=   desktop, or a display plugin
  std::string platform;         // --platform=  station runtime plugin (empty/none: standalone)
  std::string displayFallback;  // --display-fallback=desktop  run in the desktop display if the selected one fails
  std::wstring configFile;      // --config=    {input, display, platform, plugins:{<name>:{...}}} (default <exe>\xrb-app.json)
  struct PluginOption {
    std::string plugin, key, value;
  };
  std::vector<PluginOption> pluginOptions;  // --plugin.<name>.<key>=<value> (repeatable)
  // Plugins: <exe>\plugins is always searched; --plugin-dir= (repeatable) adds folders.
  std::vector<std::wstring> pluginDirs;
  bool listPlugins = false;     // --list-plugins  print "@plugins {json}" (the plugin catalog) on stdout and exit
};

HostArgs parseArgs(int argc, wchar_t** argv);
// Value of --name= straight from the raw command line (needed before CEF starts).
bool rawFlag(int argc, wchar_t** argv, const wchar_t* name, std::wstring* value);
