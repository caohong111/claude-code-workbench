import themes from '../themes.json';

export const THEME_OPTIONS = themes;
export const getTheme = value => themes.find(theme => theme.value === value) || themes[0];
