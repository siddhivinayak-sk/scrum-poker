import { RETRO_TEMPLATES, getTemplateById, getDefaultTemplate } from '../retro-templates';

describe('Retro Templates Registry', () => {
  it('contains exactly 25 templates', () => {
    expect(RETRO_TEMPLATES).toHaveLength(25);
  });

  it('each template has a non-empty kebab-case id', () => {
    const kebabCaseRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const template of RETRO_TEMPLATES) {
      expect(template.id).toBeTruthy();
      expect(template.id).toMatch(kebabCaseRegex);
    }
  });

  it('each template has a non-empty name', () => {
    for (const template of RETRO_TEMPLATES) {
      expect(template.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('each template has a non-empty columns array', () => {
    for (const template of RETRO_TEMPLATES) {
      expect(template.columns.length).toBeGreaterThan(0);
    }
  });

  it('all template ids are unique', () => {
    const ids = RETRO_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getTemplateById', () => {
  it('returns the correct template for a known id', () => {
    const template = getTemplateById('start-stop-continue');
    expect(template).toBeDefined();
    expect(template!.name).toBe('Start, Stop, Continue');
    expect(template!.columns).toEqual(['Start', 'Stop', 'Continue']);
  });

  it('returns undefined for an unknown id', () => {
    const template = getTemplateById('non-existent-template');
    expect(template).toBeUndefined();
  });
});

describe('getDefaultTemplate', () => {
  it('returns the first template in the array', () => {
    const defaultTemplate = getDefaultTemplate();
    expect(defaultTemplate).toBe(RETRO_TEMPLATES[0]);
    expect(defaultTemplate.id).toBe('went-well-improve-actions');
  });
});
