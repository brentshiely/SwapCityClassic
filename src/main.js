import Phaser from 'phaser';
import { WorldScene } from './scenes/WorldScene.js';
import { MapDebugScene } from './scenes/MapDebugScene.js';

// index.html?debug opens the map-data debug view instead of the game world.
const debug = new URLSearchParams(location.search).has('debug');

// Exposed so the game can be inspected and driven from the browser console while testing.
window.__game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#14181a',
  render: { mipmapFilter: 'LINEAR_MIPMAP_LINEAR' },
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: '100%',
    height: '100%',
  },
  scene: [debug ? MapDebugScene : WorldScene],
});
