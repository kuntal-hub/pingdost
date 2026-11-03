Pod::Spec.new do |s|
  s.name           = 'PingdostCalls'
  s.version        = '1.0.0'
  s.summary        = 'PingDost calls on iOS: PushKit VoIP pushes, CallKit and the call audio session'
  s.description    = 'Local Expo module (Phase 29, ADR 0032). Android lives in ../android.'
  s.license        = 'AGPL-3.0-or-later'
  s.author         = 'PingDost'
  s.homepage       = 'https://pingdost.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CallKit', 'PushKit', 'AVFoundation'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
