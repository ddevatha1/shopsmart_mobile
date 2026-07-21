module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // react-native-reanimated v4 moved its babel transform into the
    // separate react-native-worklets package.
    plugins: ['react-native-worklets/plugin'],
  };
};
