// The phone runs the same rules engine as the server: it is shared from ../server/src/core.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../server/src/core')];
module.exports = config;
