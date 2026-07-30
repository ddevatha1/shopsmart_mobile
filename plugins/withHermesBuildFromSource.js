const { withPodfile } = require('@expo/config-plugins');

/**
 * App Store archive dSYM fix, part 2 of 2 — see app.json's
 * `expo-build-properties` entry (`ios.buildReactNativeFromSource: true`)
 * for part 1. That plugin covers React.framework and
 * ReactNativeDependencies.framework, both gated by `ios.buildReactNativeFromSource`
 * in Podfile.properties.json. Hermes is a separate case: react-native's
 * own hermes-engine.podspec only reads a raw shell/CI environment
 * variable — `ENV['RCT_BUILD_HERMES_FROM_SOURCE']` — never anything from
 * Podfile.properties.json, so no existing Expo config plugin (including
 * expo-build-properties) can set it. Without this, Xcode Organizer's
 * "Upload Symbols Failed" error for hermes.framework has no fix at all,
 * since the prebuilt Hermes engine genuinely ships with no dSYM
 * (confirmed: no .dSYM file exists anywhere in the hermes-engine pod or
 * react-native's own SDK bundle) — building it from source is the only
 * way to get one, the same reasoning as the other two frameworks.
 *
 * A tiny local `withPodfile` plugin, not a manual edit to the generated
 * `ios/Podfile` — a manual edit would be silently wiped by the next
 * `expo prebuild --clean`, exactly like Podfile.properties.json edits
 * would be if expo-build-properties weren't handling that half.
 */
module.exports = function withHermesBuildFromSource(config) {
  return withPodfile(config, (config) => {
    const marker = "ENV['RCT_BUILD_HERMES_FROM_SOURCE']";
    if (config.modResults.contents.includes(marker)) return config;

    const anchor = "require 'json'";
    if (!config.modResults.contents.includes(anchor)) {
      throw new Error(
        "withHermesBuildFromSource: expected anchor \"require 'json'\" not found in the generated Podfile — " +
        'react-native/Expo\'s Podfile template may have changed; update this plugin to match.',
      );
    }

    config.modResults.contents = config.modResults.contents.replace(
      anchor,
      `${anchor}\n\n# Build Hermes from source too (see plugins/withHermesBuildFromSource.js) — the\n` +
      "# prebuilt Hermes engine ships with no dSYM at all, which is what Xcode\n" +
      '# Organizer\'s "Upload Symbols Failed" error for hermes.framework is reporting.\n' +
      "ENV['RCT_BUILD_HERMES_FROM_SOURCE'] ||= '1'",
    );

    return config;
  });
};
