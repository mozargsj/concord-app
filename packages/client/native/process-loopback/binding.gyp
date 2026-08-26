{
  "targets": [
    {
      "target_name": "process_loopback",
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/process_loopback.cc"],
          "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
          "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "_WIN32_WINNT=0x0A00", "WINVER=0x0A00"],
          "libraries": ["Mmdevapi.lib", "Ole32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }, {
          "sources": [],
          "type": "none"
        }]
      ]
    }
  ]
}
