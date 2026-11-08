/* Small stroke icon set (24px grid, 1.75 stroke), drawn for this app. */
import type { SVGProps } from "react";

const base = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;
type P = SVGProps<SVGSVGElement>;

export const Grid = (p: P) => (<svg {...base} {...p}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></svg>);
export const Gavel = (p: P) => (<svg {...base} {...p}><path d="m14 5 5 5" /><path d="m11.5 7.5 5 5" /><path d="m12.75 6.25 3.5-3.5 5 5-3.5 3.5" /><path d="M13 11 4.5 19.5" /><path d="M3 21h8" /></svg>);
export const Users = (p: P) => (<svg {...base} {...p}><circle cx="9" cy="8" r="3.25" /><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5" /><path d="M16 4.9a3.25 3.25 0 0 1 0 6.2" /><path d="M18 14.7c1.6.6 2.7 2.2 3 4.8" /></svg>);
export const Layers = (p: P) => (<svg {...base} {...p}><path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8Z" /><path d="m3.5 12 8.5 4.5 8.5-4.5" /><path d="m3.5 16 8.5 4.5 8.5-4.5" /></svg>);
export const Chip = (p: P) => (<svg {...base} {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></svg>);
export const Blocks = (p: P) => (<svg {...base} {...p}><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="8.5" y="3.5" width="7" height="7" rx="1.5" /><path d="M12 10.5v3" /></svg>);
export const Pulse = (p: P) => (<svg {...base} {...p}><path d="M3 12h4l2.5-6 5 12 2.5-6h4" /></svg>);
export const Arrow = (p: P) => (<svg {...base} {...p}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>);
export const External = (p: P) => (<svg {...base} {...p}><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>);
export const Lock = (p: P) => (<svg {...base} {...p}><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></svg>);
export const Eye = (p: P) => (<svg {...base} {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.75" /></svg>);
export const Wallet = (p: P) => (<svg {...base} {...p}><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="4" y="8" width="16.5" height="11" rx="2.5" /><path d="M16 13.5h1.5" /></svg>);
export const Check = (p: P) => (<svg {...base} {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>);
export const Flask = (p: P) => (<svg {...base} {...p}><path d="M9.5 3.5h5" /><path d="M10.5 3.5v5.5L5 18.5A1.5 1.5 0 0 0 6.3 20.5h11.4a1.5 1.5 0 0 0 1.3-2L13.5 9V3.5" /><path d="M7.5 15h9" /></svg>);
export const Refresh = (p: P) => (<svg {...base} {...p}><path d="M20 11a8 8 0 0 0-14.3-4.5L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M4 13a8 8 0 0 0 14.3 4.5l1.7-2" /><path d="M20 20v-4.5h-4.5" /></svg>);
