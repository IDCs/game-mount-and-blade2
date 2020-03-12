//const { app, remote } = require('electron');
const Promise = require('bluebird');
const path = require('path');
const { fs, selectors, util } = require('vortex-api');
const { parseXmlString } = require('libxmljs');

// Nexus Mods id for the game.
//const APPUNI = app || remote.app;
const GAME_ID = 'mountandblade2bannerlord';
const STEAMAPP_ID = 1059770;
const MODULES = 'Modules';
const STEAM_DLL = 'steam_api64.dll';

// Leaving this here just in case we end up needing load ordering.
//const LOAD_ORDER_PATH = path.join(APPUNI.getPath('documents'), 'Mount and Blade II Bannerlord', 'Configs', 'LauncherData.xml');

// A set of folder names (lowercased) which are available alongside the
//  game's modules folder. We could've used the fomod installer stop patterns
//  functionality for this, but it's better if this extension is self contained;
//  especially given that the game's modding pattern changes quite often.
const ROOT_FOLDERS = new Set(['bin', 'data', 'gui', 'icons', 'modules',
  'music', 'shaders', 'sounds', 'xmlschemas']);

// Bannerlord mods have this file in their root.
//  Casing is actually "SubModule.xml"
const SUBMOD_FILE = "submodule.xml";


async function getModName(subModPath) {
  return fs.readFileAsync(subModPath, { encoding: 'utf8' })
    .then(xmlData => {
      try {
        const modInfo = parseXmlString(xmlData);
        const modName = modInfo.get('//Id');
        return ((modName !== undefined) && (modName.attr('value').value() !== undefined))
          ? Promise.resolve(modName.attr('value').value())
          : Promise.reject(new util.DataInvalid('Unexpected modinfo.xml format'));
      } catch (err) {
        return Promise.reject(new util.DataInvalid('Failed to parse ModInfo.xml file'))
      }
    });
}

function findGame() {
  return util.steam.findByAppId(STEAMAPP_ID.toString())
    .then(game => game.gamePath);
}

function testRootMod(files, gameId) {
  const notSupported = { supported: false, requiredFiles: [] };
  if (gameId !== GAME_ID) {
    // Different game.
    return Promise.resolve(notSupported);
  }

  const lowered = files.map(file => file.toLowerCase());
  const modsFile = lowered.find(file => file.split(path.sep).indexOf(MODULES.toLowerCase()) !== -1);
  if (modsFile === undefined) {
    // There's no Modules folder.
    return Promise.resolve(notSupported);
  }

  const idx = modsFile.split(path.sep).indexOf(MODULES.toLowerCase());
  const rootFolderMatches = lowered.filter(file => {
    const segments = file.split(path.sep);
    return (((segments.length - 1) > idx) && ROOT_FOLDERS.has(segments[idx]));
  }) || [];

  return Promise.resolve({ supported: (rootFolderMatches.length > 0), requiredFiles: [] });
}

function installRootMod(files, destinationPath) {
  const moduleFile = files.find(file => file.split(path.sep).indexOf(MODULES) !== -1);
  const idx = moduleFile.split(path.sep).indexOf(MODULES);
  const filtered = files.filter(file => {
    const segments = file.split(path.sep).map(seg => seg.toLowerCase());
    const lastElementIdx = segments.length - 1;

    // Ignore directories and ensure that the file contains a known root folder at
    //  the expected index.
    return (ROOT_FOLDERS.has(segments[idx])
      && (path.extname(segments[lastElementIdx]) !== ''));
  });

  const instructions = filtered.map(file => {
    const destination = file.split(path.sep)
                            .slice(idx)
                            .join(path.sep);
    return {
      type: 'copy',
      source: file,
      destination,
    }
  });

  return Promise.resolve({ instructions });
}

function testForSubmodules(files, gameId) {
  // Check this is a mod for Bannerlord and it contains a SubModule.xml
  const supported = ((gameId === GAME_ID) 
    && files.find(file => path.basename(file).toLowerCase() === SUBMOD_FILE) !== undefined);

  return Promise.resolve({
    supported,
    requiredFiles: []
  })
}

async function installSubModules(files, destinationPath) {
  // Remove directories straight away.
  const filtered = files.filter(file => { 
    const segments = file.split(path.sep);
    return path.extname(segments[segments.length - 1]) !== '';
  });
  const subMods = filtered.filter(file => path.basename(file).toLowerCase() === SUBMOD_FILE);
  return Promise.reduce(subMods, async (accum, modFile) => {
    const segments = modFile.split(path.sep).filter(seg => !!seg);
    const modName = (segments.length > 1)
      ? segments[segments.length - 2]
      : await getModName(modFile);

    //const modName = await getModName(path.join(destinationPath, modFile));

    const idx = modFile.toLowerCase().indexOf(SUBMOD_FILE);
    // Filter the mod files for this specific submodule.
    const subModFiles = filtered.filter(file => file.slice(0, idx) == modFile.slice(0, idx));
    const instructions = subModFiles.map(modFile => ({
      type: 'copy',
      source: modFile,
      destination: path.join('Modules', modName, modFile.slice(idx)),
    }))
    return accum.concat(accum, instructions);
  }, [])
  .then(merged => Promise.resolve({ instructions: merged }));
}

function requiresLauncher(gamePath) {
  return fs.statAsync(path.join(gamePath, STEAM_DLL))
    .then(() => Promise.resolve({ launcher: 'steam' }))
    .catch(err => Promise.resolve(undefined));
}

function main(context) {
  const exeFile = path.join('bin', 'Win64_Shipping_Client', 'TaleWorlds.MountAndBlade.Launcher.exe');
  context.registerGame({
    id: GAME_ID,
    name: 'Mount & Blade II\t: Bannerlord',
    mergeMods: true,
    queryPath: findGame,
    supportedTools: [],
    queryModPath: () => '.',
    logo: 'gameart.jpg',
    executable: () => exeFile,
    requiredFiles: [
      exeFile
    ],
    requiresLauncher,
    environment: {
      SteamAPPId: STEAMAPP_ID.toString(),
    },
    details: {
      steamAppId: STEAMAPP_ID,
      customOpenModsPath: 'Modules',
    },
  });

  // We currently have only one mod on NM and it is a root mod.
  context.registerInstaller('bannerlordrootmod', 20, testRootMod, installRootMod);

  // Installs one or more submodules.
  context.registerInstaller('bannerlordsubmodules', 25, testForSubmodules, installSubModules);

  let previousDeployment;
  context.once(() => {
    context.api.onAsync('did-deploy', (profileId, deployment) => {
      const state = context.api.store.getState();
      const profile = selectors.profileById(state, profileId);

      if (GAME_ID !== profile.gameId) {
        return Promise.resolve();
      }

      if (previousDeployment !== deployment) {
        previousDeployment = deployment;
        context.api.sendNotification({
          type: 'info',
          allowSuppress: true,
          message: 'Use game launcher to activate mods',
        });
      }

      return Promise.resolve();
    });
  })

  return true;
}

module.exports = {
  default: main,
};
