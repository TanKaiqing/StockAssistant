export type Theme = 'light' | 'dark';
export function readTheme(): Theme {
  try {return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';} catch {return 'light';}
}
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101827' : '#f6f7fb');
  try {localStorage.setItem('theme', theme);} catch { /* Theme still works without persistent storage. */ }
}
