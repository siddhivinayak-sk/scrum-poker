import { RetroTemplate } from '../../../shared/types';

/**
 * All 25 predefined retrospective board templates.
 * Each template defines a kebab-case id, display name, and ordered column names.
 */
export const RETRO_TEMPLATES: RetroTemplate[] = [
  {
    id: 'went-well-improve-actions',
    name: 'Went well, To improve, Action items',
    columns: ['Went Well', 'To Improve', 'Action Items'],
  },
  {
    id: 'four-questions',
    name: "What went well?, What didn't go so well?, What have I learned?, What still puzzles me?",
    columns: ['Went Well', "Didn't Go Well", 'Learned', 'Still Puzzles Me'],
  },
  {
    id: 'start-stop-continue',
    name: 'Start, Stop, Continue',
    columns: ['Start', 'Stop', 'Continue'],
  },
  {
    id: 'mad-sad-glad',
    name: 'Mad, Sad, Glad',
    columns: ['Mad', 'Sad', 'Glad'],
  },
  {
    id: 'four-ls',
    name: 'Liked, Learned, Lacked, Longed for',
    columns: ['Liked', 'Learned', 'Lacked', 'Longed For'],
  },
  {
    id: 'kalm',
    name: 'Keep, Add, Less, More',
    columns: ['Keep', 'Add', 'Less', 'More'],
  },
  {
    id: 'sailboat',
    name: 'Sailboat',
    columns: ['Wind', 'Anchor', 'Rocks', 'Island'],
  },
  {
    id: 'starfish',
    name: 'Starfish',
    columns: ['Keep Doing', 'More Of', 'Less Of', 'Stop Doing', 'Start Doing'],
  },
  {
    id: 'plus-delta',
    name: 'Plus/Delta',
    columns: ['Plus', 'Delta'],
  },
  {
    id: 'hot-air-balloon',
    name: 'Hot Air Balloon',
    columns: ['Hot Air', 'Sandbags', 'Storm Clouds'],
  },
  {
    id: 'daki',
    name: 'DAKI',
    columns: ['Drop', 'Add', 'Keep', 'Improve'],
  },
  {
    id: 'rose-bud-thorn',
    name: 'Rose, Bud, Thorn',
    columns: ['Rose', 'Bud', 'Thorn'],
  },
  {
    id: 'lean-coffee',
    name: 'Lean Coffee',
    columns: ['To Discuss', 'Discussing', 'Discussed'],
  },
  {
    id: 'speed-car',
    name: 'Speed Car',
    columns: ['Engine', 'Parachute', 'Abyss'],
  },
  {
    id: 'three-little-pigs',
    name: 'Three Little Pigs',
    columns: ['House of Straw', 'House of Sticks', 'House of Bricks'],
  },
  {
    id: 'mountain-climber',
    name: 'Mountain Climber',
    columns: ['Summit', 'Cliff', 'Backpack', 'Base Camp'],
  },
  {
    id: 'traffic-light',
    name: 'Traffic Light',
    columns: ['Green', 'Amber', 'Red'],
  },
  {
    id: 'weather-forecast',
    name: 'Weather Forecast',
    columns: ['Sunny', 'Cloudy', 'Rainy', 'Stormy'],
  },
  {
    id: 'good-bad-ugly',
    name: 'The Good, The Bad, The Ugly',
    columns: ['The Good', 'The Bad', 'The Ugly'],
  },
  {
    id: 'energy-levels',
    name: 'Energy Levels',
    columns: ['High Energy', 'Neutral', 'Low Energy'],
  },
  {
    id: 'thumbs-ideas-recognition',
    name: 'Thumbs Up, Thumbs Down, New Ideas, Recognition',
    columns: ['👍 Thumbs Up', '👎 Thumbs Down', '💡 New Ideas', '🏆 Recognition'],
  },
  {
    id: 'happy-meh-sad',
    name: 'Happy, Meh, Sad',
    columns: ['Happy', 'Meh', 'Sad'],
  },
  {
    id: 'hope-worry-risk-mitigation',
    name: 'Hope, Worry, Risk, Mitigation',
    columns: ['Hope', 'Worry', 'Risk', 'Mitigation'],
  },
  {
    id: 'scrum-values',
    name: 'Scrum Values',
    columns: ['Courage', 'Focus', 'Commitment', 'Respect', 'Openness'],
  },
  {
    id: 'www',
    name: 'WWW',
    columns: ['Worked', 'Kinda Worked', "Didn't Work"],
  },
];

/**
 * Retrieve a template by its kebab-case ID.
 * @returns The matching RetroTemplate, or undefined if not found
 */
export function getTemplateById(id: string): RetroTemplate | undefined {
  return RETRO_TEMPLATES.find((template) => template.id === id);
}

/**
 * Retrieve the default template (first in the list).
 * @returns The first RetroTemplate entry
 */
export function getDefaultTemplate(): RetroTemplate {
  return RETRO_TEMPLATES[0];
}
