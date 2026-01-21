const path = require("path");
module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      [
        'module-resolver',
        {
          root: ['./'],
          alias: {
            '@': './',
            '@/src': './src',
            '@/src/components': './src/components',
            '@/src/hooks': './src/hooks',
            '@/components': './components',
            '@/app': './app',
            '@/app/assets': './app/assets',
            'react-native-css-interop/jsx-runtime': path.resolve(__dirname, 'node_modules/react-native-css-interop/dist/runtime/jsx-runtime'),
            'react-native-css-interop/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react-native-css-interop/dist/runtime/jsx-dev-runtime'),
          },
        },
      ],
      'react-native-reanimated/plugin',
    ],
  }
}
