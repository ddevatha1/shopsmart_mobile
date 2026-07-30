const { withPodfile } = require('@expo/config-plugins');

/**
 * App Store archive dSYM fix, part 3 of 3 — see app.json's
 * `expo-build-properties` entry (part 1: React.framework/
 * ReactNativeDependencies.framework) and
 * plugins/withHermesBuildFromSource.js (part 2: hermes.framework).
 *
 * Building React Native + Hermes from source is necessary but NOT
 * sufficient on its own: confirmed live (a real from-source Release
 * archive still produced a dSYMs folder with only the app's own
 * `.app.dSYM`, none of the three Pod frameworks) — CocoaPods-generated
 * targets don't automatically get `DEBUG_INFORMATION_FORMAT =
 * dwarf-with-dsym` for Release, so even a locally-compiled framework
 * still doesn't get Xcode to emit a dSYM for it. This forces that
 * setting for every Pods target's Release configuration only (Debug
 * intentionally keeps the faster plain `dwarf` format — dSYMs are only
 * ever needed for what gets archived/uploaded).
 *
 * Must be injected INSIDE Expo's own existing `post_install do |installer|
 * ... end` block (which calls `react_native_post_install`), never as a
 * second, separate `post_install` block — CocoaPods only honors the
 * LAST-registered `post_install` hook in a Podfile, so a second one would
 * silently replace (not run alongside) the one that wires up autolinking,
 * Hermes configuration, and every other required RN post-install step.
 */
module.exports = function withDsymForReleaseBuilds(config) {
  return withPodfile(config, (config) => {
    const marker = "target.build_configurations.each do |build_config|\n        next unless build_config.name == 'Release'\n        build_config.build_settings['DEBUG_INFORMATION_FORMAT'] = 'dwarf-with-dsym'";
    if (config.modResults.contents.includes(marker)) return config;

    const anchor = ':ccache_enabled => ccache_enabled?(podfile_properties),\n    )\n  end';
    if (!config.modResults.contents.includes(anchor)) {
      throw new Error(
        'withDsymForReleaseBuilds: expected anchor (the end of the existing ' +
        'react_native_post_install call) not found in the generated Podfile — ' +
        'react-native/Expo\'s Podfile template may have changed; update this plugin to match.',
      );
    }

    config.modResults.contents = config.modResults.contents.replace(
      anchor,
      ":ccache_enabled => ccache_enabled?(podfile_properties),\n    )\n\n" +
      "    # Force real dSYMs for Pod frameworks in Release archives — see\n" +
      "    # plugins/withDsymForReleaseBuilds.js for why building from source\n" +
      "    # alone doesn't already do this.\n" +
      "    installer.pods_project.targets.each do |target|\n" +
      "      target.build_configurations.each do |build_config|\n" +
      "        next unless build_config.name == 'Release'\n" +
      "        build_config.build_settings['DEBUG_INFORMATION_FORMAT'] = 'dwarf-with-dsym'\n" +
      "      end\n" +
      "    end\n" +
      '  end',
    );

    return config;
  });
};
