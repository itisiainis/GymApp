const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite на вебе тянет SQLite, собранный в WebAssembly.
// Metro по умолчанию не знает расширение .wasm — объявляем его ассетом.
config.resolver.assetExts.push('wasm');

module.exports = config;
