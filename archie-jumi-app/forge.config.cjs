module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'archie-jumi',
    icon: './public/icon.ico',
    appBundleId: 'com.archiejumi.desktop',
    // Main, preload and renderer code are bundled; ship only their runtime output.
    // In particular, never include test profiles, captures or work directories.
    prune: false,
    ignore: file => file !== '' && !/^\/(?:dist(?:\/|$)|package\.json$)/.test(file.replace(/\\/g, '/')),
  },
  makers: [{ name: '@electron-forge/maker-squirrel', config: { name: 'archie_jumi', setupExe: 'ArchieJumiSetup.exe', setupIcon: './public/icon.ico', noMsi: true } }]
};
