export const APP_NAME = 'Underlings';
export const TAGLINE = 'Agents and reviews';
export const APP_ID = 'com.thenightproject.underlings';
export const FOLDER = 'underlings';

// The page's HTML names the app only through these, so it is named here and nowhere else.
export const branded = (html) => html.replaceAll('{{APP_NAME}}', APP_NAME).replaceAll('{{TAGLINE}}', TAGLINE).replaceAll('{{FOLDER}}', FOLDER);
