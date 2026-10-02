# Applies agmux's settings to the Capacitor-generated Xcode project.
# Run after `npx cap add ios` (regeneration wipes them):
#   GEM_HOME="$(brew --prefix cocoapods)/libexec" ruby scripts/configure-xcode-project.rb
require 'xcodeproj'

PROJECT = File.expand_path('../ios/App/App.xcodeproj', __dir__)
SOURCES = %w[KeychainStore.swift PairingPersistence.swift AgmuxBridgeViewController.swift].freeze
RESOURCES = %w[PrivacyInfo.xcprivacy].freeze

COMMON = {
  'IPHONEOS_DEPLOYMENT_TARGET' => '17.0',
  'TARGETED_DEVICE_FAMILY' => '1',
  'MARKETING_VERSION' => '1.0.0',
  'CURRENT_PROJECT_VERSION' => '1',
  'DEVELOPMENT_TEAM' => 'VTQW687WBQ',
  'CODE_SIGN_ENTITLEMENTS' => 'App/App.entitlements',
}.freeze
DEBUG = { 'CODE_SIGN_STYLE' => 'Automatic' }.freeze
RELEASE = {
  'CODE_SIGN_STYLE' => 'Manual',
  'CODE_SIGN_IDENTITY' => 'Apple Distribution',
  'PROVISIONING_PROFILE_SPECIFIER' => 'agmux Remote App Store',
}.freeze

project = Xcodeproj::Project.open(PROJECT)
target = project.targets.find { |t| t.name == 'App' } or abort('App target not found')
group = project.main_group.find_subpath('App', false) or abort('App group not found')

def ensure_file(group, name)
  group.files.find { |f| f.path == name } || group.new_reference(name)
end

SOURCES.each do |name|
  ref = ensure_file(group, name)
  target.source_build_phase.add_file_reference(ref, true)
end
RESOURCES.each do |name|
  ref = ensure_file(group, name)
  target.resources_build_phase.add_file_reference(ref, true)
end
ensure_file(group, 'App.entitlements')

project.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = COMMON['IPHONEOS_DEPLOYMENT_TARGET']
end
target.build_configurations.each do |config|
  extra = config.name == 'Release' ? RELEASE : DEBUG
  config.build_settings.merge!(COMMON).merge!(extra)
end

project.save
puts "Configured #{PROJECT}"
