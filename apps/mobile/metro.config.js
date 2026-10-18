// Expo's Metro config handles the pnpm monorepo itself (SDK 52+): no watchFolders or
// nodeModulesPaths here. Workspace packages export TypeScript source, which Metro compiles.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

module.exports = withNativeWind(getDefaultConfig(__dirname), { input: './src/global.css' });
