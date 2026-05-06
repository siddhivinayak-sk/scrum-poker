import {
  Component,
  OnDestroy,
  ViewChild,
  ElementRef,
  input,
  effect,
  AfterViewInit,
} from '@angular/core';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  opacity: number;
  rotation: number;
  rotationSpeed: number;
}

const PARTICLE_COLORS = [
  '#FFD700', // gold
  '#FFC107', // amber
  '#FFEB3B', // yellow
  '#FFFFFF', // white
  '#FFA000', // dark amber
];

const MAX_PARTICLES = 50;
const ANIMATION_DURATION_MS = 3000;

@Component({
  selector: 'app-stars-animation',
  standalone: true,
  template: `<canvas #canvas class="stars-canvas" aria-hidden="true"></canvas>`,
  styles: [
    `
      :host {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 100;
      }
      .stars-canvas {
        width: 100%;
        height: 100%;
        display: block;
      }
    `,
  ],
})
export class StarsAnimationComponent implements OnDestroy, AfterViewInit {
  readonly active = input<boolean>(false);

  @ViewChild('canvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private animationFrameId: number | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private particles: Particle[] = [];
  private viewReady = false;

  constructor() {
    effect(() => {
      const isActive = this.active();
      if (isActive && this.viewReady) {
        this.startAnimation();
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    // If active was already true before view init, start now
    if (this.active()) {
      this.startAnimation();
    }
  }

  ngOnDestroy(): void {
    this.stopAnimation();
  }

  private startAnimation(): void {
    if (this.prefersReducedMotion()) {
      return;
    }

    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to match element size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width || 300;
    canvas.height = rect.height || 200;

    // Create particles
    this.particles = this.createParticles(canvas.width, canvas.height);

    // Start animation loop
    const startTime = performance.now();
    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / ANIMATION_DURATION_MS, 1);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const particle of this.particles) {
        // Update position
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vy += 0.1; // gravity
        particle.rotation += particle.rotationSpeed;

        // Fade out in the last third
        const fadeStart = 0.6;
        if (progress > fadeStart) {
          particle.opacity = 1 - (progress - fadeStart) / (1 - fadeStart);
        }

        // Draw particle
        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.rotation);
        ctx.globalAlpha = particle.opacity;
        ctx.fillStyle = particle.color;
        ctx.fillRect(
          -particle.size / 2,
          -particle.size / 2,
          particle.size,
          particle.size
        );
        ctx.restore();
      }

      if (progress < 1) {
        this.animationFrameId = requestAnimationFrame(animate);
      } else {
        this.clearCanvas(ctx, canvas.width, canvas.height);
      }
    };

    this.animationFrameId = requestAnimationFrame(animate);

    // Safety timeout to ensure cleanup
    this.timeoutId = setTimeout(() => {
      this.stopAnimation();
    }, ANIMATION_DURATION_MS + 100);
  }

  private createParticles(width: number, height: number): Particle[] {
    const particles: Particle[] = [];
    const count = Math.min(MAX_PARTICLES, 50);

    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height * 0.3, // Start in top 30%
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * -3 + 1,
        size: Math.random() * 6 + 2,
        color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
        opacity: 1,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.1,
      });
    }

    return particles;
  }

  private clearCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.clearRect(0, 0, width, height);
  }

  private stopAnimation(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.particles = [];

    // Clear the canvas
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }
}
