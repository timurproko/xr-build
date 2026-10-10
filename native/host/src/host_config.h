#pragma once
// Which provider runs each role and what configuration each gets (design D7).
//
// Sources, strongest first: the command line (--input= ..., --plugin.<name>.<key>=<value>), the
// config file (--config=, else <exe>\xrb-app.json written by a packager; a project manifest has
// the same shape), then the defaults (input none, display desktop, no platform).
#include <string>

#include "args.h"
#include "json_util.h"

namespace hostcfg {

struct Selection {
  std::string input, display, platform, displayFallback;
};

// Reads a JSON object from `path`. Missing file: false with an empty error.
bool loadFile(const std::wstring& path, nlohmann::json* out, std::string* error);

Selection selectRoles(const nlohmann::json& file, const HostArgs& args);

// "8000" -> 8000, "true" -> true, "[1,2]" -> [1,2], "\"x\"" -> "x", anything else -> the string itself.
nlohmann::json inferValue(const std::string& text);

// file.plugins[name] with every --plugin.<name>.<key>=<value> of `args` set on top; dotted keys
// create nested objects ("area.size" -> {"area":{"size":...}}).
nlohmann::json pluginConfig(const nlohmann::json& file, const std::string& name, const HostArgs& args);

}  // namespace hostcfg
