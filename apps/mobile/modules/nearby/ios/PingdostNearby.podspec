Pod::Spec.new do |s|
  s.name           = 'PingdostNearby'
  s.version        = '1.0.0'
  s.summary        = 'PingDost nearby on iOS: CoreBluetooth links with the Android framing'
  s.description    = 'Local Expo module (Phase 30, ADR 0033). Core/ is tested on Linux via Package.swift.'
  s.license        = 'AGPL-3.0-or-later'
  s.author         = 'PingDost'
  s.homepage       = 'https://pingdost.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth'

  s.source_files = '*.swift', 'Core/*.swift'
  s.exclude_files = 'Package.swift', 'Tests/**/*'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
