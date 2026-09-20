import Phaser from 'phaser';

// Placeholder scene for the scaffold card: proves Phaser 3 runs and shows the frame rate.
export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  create() {
    const { width, height } = this.scale;
    this.title = this.add
      .text(width / 2, height / 2, 'SwapCityClassic', {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '56px',
        color: '#e6ac00',
      })
      .setOrigin(0.5);
    this.fps = this.add.text(12, 10, '', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#9ba5ad',
    });
    this.scale.on('resize', (size) => this.title.setPosition(size.width / 2, size.height / 2));
  }

  update() {
    this.fps.setText(`${Math.round(this.game.loop.actualFps)} fps`);
  }
}
