export const colors = {
  ink: '#f5f6f7',
  white: '#ffffff',
  muted: '#9b9ea4',
  canvas: '#111214',
  panel: '#1a1b1e',
  panelAlt: '#292b2f',
  line: '#35373c',
  charcoal: '#17181b',
  route: '#ec3347',
  routeAlt: '#2856d8',
  action: '#149ed0',
  actionGreen: '#17b978',
  warning: '#f2aa32',
  green: '#149ed0',
  greenDark: '#127fa6',
  amber: '#f2aa32',
  rust: '#ec3347',
  blue: '#2856d8',
  sky: '#292b2f',
};

// Compact controls, content surfaces and map sheets share one radius scale.
export const radii = { sm: 10, md: 12, lg: 20 };
export const typography = {
  title: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.6 },
  heading: { fontSize: 20, fontWeight: '600' as const, letterSpacing: -0.3 },
  body: { fontSize: 16, lineHeight: 23 },
  caption: { fontSize: 13, lineHeight: 18 },
};
export const spacing = { xs: 6, sm: 10, md: 14, lg: 20, xl: 28 };

export const tabBarStyle = {
  backgroundColor: colors.charcoal,
  borderTopColor: colors.panelAlt,
  minHeight: 76,
  paddingBottom: 11,
  paddingTop: 9,
};
