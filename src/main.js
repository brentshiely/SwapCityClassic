import Phaser from 'phaser';
import { MapDebugScene } from './scenes/MapDebugScene.js';

// Exposed so the game can be inspected and driven from the browser console while testing.
window.__game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#1b1f22',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: '100%',
    height: '100%',
  },
  scene: [MapDebugScene],
});
