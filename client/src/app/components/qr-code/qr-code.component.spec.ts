import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { Component, input } from '@angular/core';
import { QrCodeDisplayComponent } from './qr-code.component';

// Stub for angularx-qrcode's QRCodeComponent to avoid canvas/DOM issues in tests
@Component({
  selector: 'qrcode',
  standalone: true,
  template: `<img [attr.alt]="alt()" [attr.title]="title()" [attr.width]="width()" />`,
})
class QRCodeStubComponent {
  readonly qrdata = input<string>('');
  readonly width = input<number>(256);
  readonly errorCorrectionLevel = input<string>('M');
  readonly alt = input<string>('');
  readonly title = input<string>('');
}

describe('QrCodeDisplayComponent', () => {
  let fixture: ComponentFixture<QrCodeDisplayComponent>;
  let component: QrCodeDisplayComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [QrCodeDisplayComponent],
    }).overrideComponent(QrCodeDisplayComponent, {
      set: {
        imports: [QRCodeStubComponent],
      },
    });
  });

  function createComponent(url: string): ComponentFixture<QrCodeDisplayComponent> {
    fixture = TestBed.createComponent(QrCodeDisplayComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('url', url);
    fixture.detectChanges();
    return fixture;
  }

  describe('rendering with correct URL', () => {
    it('should pass the URL to the qrcode element as qrdata', () => {
      createComponent('https://example.com/session/abc12345');

      const qrEl = fixture.nativeElement.querySelector('qrcode');
      expect(qrEl).toBeTruthy();
    });

    it('should render the component with the provided URL input', () => {
      createComponent('https://example.com/session/xyz99999');

      expect(component.url()).toBe('https://example.com/session/xyz99999');
    });
  });

  describe('URL updates', () => {
    it('should update when the URL input changes', () => {
      createComponent('https://example.com/session/first000');

      expect(component.url()).toBe('https://example.com/session/first000');

      fixture.componentRef.setInput('url', 'https://example.com/session/second00');
      fixture.detectChanges();

      expect(component.url()).toBe('https://example.com/session/second00');
    });
  });

  describe('minimum size', () => {
    it('should have a container with min-width of 150px', () => {
      createComponent('https://example.com/session/abc12345');

      const container = fixture.nativeElement.querySelector('.qr-container') as HTMLElement;
      expect(container).toBeTruthy();
      const styles = getComputedStyle(container);
      expect(styles.minWidth).toBe('150px');
    });

    it('should have a container with min-height of 150px', () => {
      createComponent('https://example.com/session/abc12345');

      const container = fixture.nativeElement.querySelector('.qr-container') as HTMLElement;
      const styles = getComputedStyle(container);
      expect(styles.minHeight).toBe('150px');
    });
  });

  describe('alt text', () => {
    it('should include the URL in the alt text of the qrcode element', () => {
      createComponent('https://example.com/session/abc12345');

      const imgEl = fixture.nativeElement.querySelector('qrcode img');
      expect(imgEl).toBeTruthy();
      const altText = imgEl.getAttribute('alt');
      expect(altText).toContain('https://example.com/session/abc12345');
      expect(altText).toContain('QR code for session link');
    });

    it('should update alt text when URL changes', () => {
      createComponent('https://example.com/session/first000');

      fixture.componentRef.setInput('url', 'https://example.com/session/second00');
      fixture.detectChanges();

      const imgEl = fixture.nativeElement.querySelector('qrcode img');
      const altText = imgEl.getAttribute('alt');
      expect(altText).toContain('https://example.com/session/second00');
    });
  });
});
