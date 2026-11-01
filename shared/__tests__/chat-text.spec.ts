import { validateChatText } from '../chat-text';
import { CHAT_MESSAGE_MAX_LENGTH, CHAT_RAW_TEXT_MAX_LENGTH } from '../types';

/**
 * Unit tests for the Chat_Validator (validateChatText).
 * Validates: Requirements 22.1, 14.2, 14.3, 14.4, 14.5, 14.6
 */
describe('validateChatText', () => {
  it('uses the specified limits', () => {
    expect(CHAT_MESSAGE_MAX_LENGTH).toBe(500);
    expect(CHAT_RAW_TEXT_MAX_LENGTH).toBe(2000);
  });

  describe('non-string values (R14.2)', () => {
    it('returns CHAT_INVALID for a number', () => {
      expect(validateChatText(42)).toEqual({ ok: false, code: 'CHAT_INVALID' });
    });

    it.each([undefined, null, true, ['hi'], { text: 'hi' }])(
      'returns CHAT_INVALID for %p',
      (value) => {
        expect(validateChatText(value)).toEqual({ ok: false, code: 'CHAT_INVALID' });
      },
    );
  });

  describe('empty Normalised_Text (R14.5)', () => {
    it('returns CHAT_EMPTY for space, a disallowed control and a tab', () => {
      expect(validateChatText(' \u0001\t')).toEqual({ ok: false, code: 'CHAT_EMPTY' });
    });

    it('returns CHAT_EMPTY for the empty string', () => {
      expect(validateChatText('')).toEqual({ ok: false, code: 'CHAT_EMPTY' });
    });
  });

  describe('Normalised_Text length (R14.6)', () => {
    it('accepts 500 UTF-16 code units', () => {
      const text = 'a'.repeat(500);
      expect(validateChatText(text)).toEqual({ ok: true, text });
    });

    it('accepts 500 code units made of surrogate pairs', () => {
      const text = '\u{1F600}'.repeat(250);
      expect(text.length).toBe(500);
      expect(validateChatText(text)).toEqual({ ok: true, text });
    });

    it('returns CHAT_TOO_LONG for 501 UTF-16 code units', () => {
      expect(validateChatText('a'.repeat(501))).toEqual({ ok: false, code: 'CHAT_TOO_LONG' });
    });

    it('counts length after trimming', () => {
      const text = 'a'.repeat(500);
      expect(validateChatText(`   ${text}\n\n`)).toEqual({ ok: true, text });
    });
  });

  describe('raw length (R14.3)', () => {
    it('returns CHAT_TOO_LONG for 2,001 raw code units even when normalisation would shorten it', () => {
      const raw = 'a' + ' '.repeat(2000);
      expect(raw.length).toBe(2001);
      expect(validateChatText(raw)).toEqual({ ok: false, code: 'CHAT_TOO_LONG' });
    });

    it('returns CHAT_TOO_LONG for 2,001 raw code units of whitespace instead of CHAT_EMPTY', () => {
      expect(validateChatText(' '.repeat(2001))).toEqual({ ok: false, code: 'CHAT_TOO_LONG' });
    });

    it('normalises 2,000 raw code units that trim down to an accepted text', () => {
      const raw = ' '.repeat(1000) + 'hello' + '\t'.repeat(995);
      expect(raw.length).toBe(2000);
      expect(validateChatText(raw)).toEqual({ ok: true, text: 'hello' });
    });

    it('normalises 2,000 raw code units of whitespace to CHAT_EMPTY', () => {
      expect(validateChatText(' '.repeat(2000))).toEqual({ ok: false, code: 'CHAT_EMPTY' });
    });
  });

  describe('normalisation (R14.4)', () => {
    it('keeps interior tabs and consecutive line feeds', () => {
      expect(validateChatText('a\tb\n\n\nc')).toEqual({ ok: true, text: 'a\tb\n\n\nc' });
    });

    it('keeps interior spaces', () => {
      expect(validateChatText('a   b')).toEqual({ ok: true, text: 'a   b' });
    });

    it('converts \\r\\n and lone \\r to \\n', () => {
      expect(validateChatText('a\r\nb\rc')).toEqual({ ok: true, text: 'a\nb\nc' });
    });

    it('removes disallowed characters including bidi controls', () => {
      expect(validateChatText('a\u0000b\u007Fc\u202Ed\u2066e')).toEqual({ ok: true, text: 'abcde' });
    });

    it('trims U+FEFF, U+2028, U+2029 and Zs characters from both ends', () => {
      expect(validateChatText('\uFEFF\u00A0\u2028hi\u2029\u3000 ')).toEqual({ ok: true, text: 'hi' });
    });
  });
});
