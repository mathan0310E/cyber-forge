import type { ProjectCategory } from '@wolf-forge/shared-types';

export interface TemplatePreview {
  category: ProjectCategory;
  label: string;
  description: string;
  image: string;
  headingFont: string;
  palette: {
    background: string;
    surface: string;
    primary: string;
    accent: string;
    text: string;
    textMuted: string;
  };
  examplePrompts: string[];
  pages: Array<{ name: string; route: string; purpose: string }>;
}

const DARK = {
  background: '#0b0d12',
  surface: '#141922',
  text: '#f5f5f5',
  textMuted: '#9aa4b2',
} as const;

const LIGHT = {
  background: '#fbfaf7',
  surface: '#ffffff',
  text: '#16181d',
  textMuted: '#5a6472',
} as const;

function palette(theme: 'light' | 'dark', primary: string, accent: string) {
  const base = theme === 'light' ? LIGHT : DARK;
  return { ...base, primary, accent };
}

export const TEMPLATE_PREVIEWS: Record<ProjectCategory, TemplatePreview> = {
  portfolio: {
    category: 'portfolio',
    label: 'Portfolio',
    description:
      'A personal site with a strong hero, a project grid and a way to get in touch.',
    image: '/templates/portfolio.svg',
    headingFont: "'Space Grotesk', system-ui, sans-serif",
    palette: palette('dark', '#19d3f3', '#d7f542'),
    examplePrompts: [
      'Build a modern portfolio for a cybersecurity student with a dark background, neon green accents, animated project cards and a contact form.',
      'A minimal photography portfolio with a large image grid and an about section.',
    ],
    pages: [
      { name: 'Home', route: '/', purpose: 'Introduce the person and surface the strongest work.' },
      { name: 'About', route: '/about', purpose: 'Background, skills and approach.' },
      { name: 'Contact', route: '/contact', purpose: 'A working contact form with client-side validation.' },
    ],
  },
  business: {
    category: 'business',
    label: 'Business website',
    description: 'Services, proof and contact details for a small company.',
    image: '/templates/business.svg',
    headingFont: "'Fraunces', Georgia, serif",
    palette: palette('light', '#1f6feb', '#ff8a24'),
    examplePrompts: [
      'Build a website for a family-run landscaping business with a services list, a gallery and a contact form.',
    ],
    pages: [
      { name: 'Home', route: '/', purpose: 'Explain the business and drive enquiries.' },
      { name: 'Services', route: '/services', purpose: 'Detail each service.' },
      { name: 'Contact', route: '/contact', purpose: 'Contact form and details.' },
    ],
  },
  'landing-page': {
    category: 'landing-page',
    label: 'Landing page',
    description: 'A single focused page built around one call to action.',
    image: '/templates/landing-page.svg',
    headingFont: "'Space Grotesk', system-ui, sans-serif",
    palette: palette('dark', '#d7f542', '#9b5cff'),
    examplePrompts: [
      'Build a landing page for a productivity app with a hero, feature list, pricing and an email signup.',
    ],
    pages: [{ name: 'Home', route: '/', purpose: 'Convert a visitor into a signup.' }],
  },
  blog: {
    category: 'blog',
    label: 'Blog',
    description: 'An article index and post layout with readable typography.',
    image: '/templates/blog.svg',
    headingFont: "'Fraunces', Georgia, serif",
    palette: palette('light', '#0f766e', '#ff8a24'),
    examplePrompts: [
      'Build a minimal blog with a post list, reading-friendly typography and an about page.',
    ],
    pages: [
      { name: 'Home', route: '/', purpose: 'Index of recent writing.' },
      { name: 'About', route: '/about', purpose: 'Who writes here.' },
    ],
  },
  ecommerce: {
    category: 'ecommerce',
    label: 'E-commerce storefront',
    description: 'A product grid and detail layout. No payment processing included.',
    image: '/templates/ecommerce.svg',
    headingFont: "'Fraunces', Georgia, serif",
    palette: palette('light', '#b45309', '#19d3f3'),
    examplePrompts: [
      'Build a storefront for a ceramics studio with a product grid, product detail pages and a cart summary.',
    ],
    pages: [
      { name: 'Home', route: '/', purpose: 'Show the range and route to products.' },
      { name: 'Products', route: '/products', purpose: 'Full catalogue.' },
    ],
  },
  'saas-dashboard': {
    category: 'saas-dashboard',
    label: 'SaaS dashboard',
    description: 'A data-focused shell with metric cards and a chart placeholder.',
    image: '/templates/saas-dashboard.svg',
    headingFont: "'Space Grotesk', system-ui, sans-serif",
    palette: palette('dark', '#19d3f3', '#9b5cff'),
    examplePrompts: [
      'Build an analytics dashboard with a sidebar, metric cards and a usage chart.',
    ],
    pages: [{ name: 'Home', route: '/', purpose: 'Overview of the product and its main metrics.' }],
  },
  education: {
    category: 'education',
    label: 'Educational website',
    description: 'A course outline with modules, schedule and enrolment.',
    image: '/templates/education.svg',
    headingFont: "'Fraunces', Georgia, serif",
    palette: palette('light', '#4338ca', '#d7f542'),
    examplePrompts: [
      'Build a course website for an introductory Python class with a syllabus, schedule and enrolment form.',
    ],
    pages: [
      { name: 'Home', route: '/', purpose: 'Describe the course and who it is for.' },
      { name: 'Syllabus', route: '/syllabus', purpose: 'Full syllabus.' },
    ],
  },
  event: {
    category: 'event',
    label: 'Event registration',
    description: 'Event details, agenda and a registration form.',
    image: '/templates/event.svg',
    headingFont: "'Space Grotesk', system-ui, sans-serif",
    palette: palette('dark', '#ff8a24', '#19d3f3'),
    examplePrompts: [
      'Build a registration page for a one-day security conference with an agenda and signup form.',
    ],
    pages: [{ name: 'Home', route: '/', purpose: 'Event details and registration.' }],
  },
  documentation: {
    category: 'documentation',
    label: 'Documentation site',
    description: 'A docs layout with navigation and content sections.',
    image: '/templates/documentation.svg',
    headingFont: "'Space Grotesk', system-ui, sans-serif",
    palette: palette('light', '#0f172a', '#19d3f3'),
    examplePrompts: [
      'Build a documentation site for a small API with a sidebar, getting started guide and reference pages.',
    ],
    pages: [
      { name: 'Home', route: '/', purpose: 'Entry point into the docs.' },
      { name: 'Reference', route: '/reference', purpose: 'API reference.' },
    ],
  },
  custom: {
    category: 'custom',
    label: 'Custom application',
    description: 'A flexible starting point when nothing else fits.',
    image: '/templates/custom.svg',
    headingFont: "'Space Grotesk', system-ui, sans-serif",
    palette: palette('dark', '#19d3f3', '#ff8a24'),
    examplePrompts: ['Build a website for my community garden with events, photos and a join form.'],
    pages: [
      { name: 'Home', route: '/', purpose: 'Landing page for the project.' },
      { name: 'Contact', route: '/contact', purpose: 'Contact form.' },
    ],
  },
};

export function templateSummaries() {
  return Object.values(TEMPLATE_PREVIEWS);
}
