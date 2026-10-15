import type {
  BriefAnalysis,
  DesignTokens,
  ProjectCategory,
  ProjectTheme,
  SitePage,
  WebsiteSpec,
} from '@wolf-forge/shared-types';
import { toComponentName } from './scaffold.js';

/**
 * Built-in starter templates.
 *
 * These are real, deterministic website generators — the same engine that backs
 * the public /templates page. They serve two purposes:
 *
 *  1. A user with no AI provider configured still gets a working, buildable,
 *     previewable website instead of an error. The build log states plainly that
 *     the built-in template engine was used, and the version history records it.
 *  2. They seed the AI pipeline with a valid structure, so a free model has a
 *     correct skeleton to edit rather than a blank page to invent.
 *
 * They are never presented as AI output.
 */

export type SectionKind =
  | 'hero'
  | 'features'
  | 'gallery'
  | 'about'
  | 'contact'
  | 'pricing'
  | 'posts'
  | 'products'
  | 'faq'
  | 'steps'
  | 'cta'
  | 'schedule';

export interface SectionPlan {
  kind: SectionKind;
  heading: string;
  body: string;
  items: Array<{ title: string; body: string }>;
}

export interface PagePlan {
  name: string;
  route: string;
  purpose: string;
  sections: SectionPlan[];
}

export interface TemplatePalette {
  background: string;
  surface: string;
  primary: string;
  accent: string;
  text: string;
  textMuted: string;
}

export interface TemplateDefinition {
  category: ProjectCategory;
  label: string;
  description: string;
  /** Short prompts that reproduce this template; shown on /templates. */
  examplePrompts: string[];
  pages: PagePlan[];
  palette: TemplatePalette;
  headingFont: string;
}

const DARK: Omit<TemplatePalette, 'primary' | 'accent'> = {
  background: '#0b0d12',
  surface: '#141922',
  text: '#f5f5f5',
  textMuted: '#9aa4b2',
};

const LIGHT: Omit<TemplatePalette, 'primary' | 'accent'> = {
  background: '#fbfaf7',
  surface: '#ffffff',
  text: '#16181d',
  textMuted: '#5a6472',
};

function palette(
  theme: ProjectTheme,
  primary: string,
  accent: string,
): TemplatePalette {
  const base = theme === 'light' ? LIGHT : DARK;
  return { ...base, primary, accent };
}

function section(
  kind: SectionKind,
  heading: string,
  body: string,
  items: Array<[string, string]> = [],
): SectionPlan {
  return { kind, heading, body, items: items.map(([title, body]) => ({ title, body })) };
}

export const TEMPLATES: Record<ProjectCategory, TemplateDefinition> = {
  portfolio: {
    category: 'portfolio',
    label: 'Portfolio',
    description:
      'A personal site with a strong hero, a project grid and a way to get in touch.',
    examplePrompts: [
      'Build a modern portfolio for a cybersecurity student with a dark background, neon green accents, animated project cards and a contact form.',
      'A minimal photography portfolio with a large image grid and an about section.',
    ],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Introduce the person and surface the strongest work.',
        sections: [
          section('hero', 'Hi, I build things for the web.', 'Short positioning statement and a call to action.', [
            ['View work', 'Jump straight to the project grid.'],
            ['Get in touch', 'Open the contact page.'],
          ]),
          section('features', 'What I do', 'Three or four capability areas.', [
            ['Frontend engineering', 'Accessible, responsive interfaces.'],
            ['Security', 'Threat modelling and hardening.'],
            ['Tooling', 'Build pipelines and automation.'],
          ]),
          section('gallery', 'Selected work', 'Project cards.', [
            ['Project One', 'A short description of what it does and the outcome.'],
            ['Project Two', 'A short description of what it does and the outcome.'],
            ['Project Three', 'A short description of what it does and the outcome.'],
          ]),
          section('cta', 'Open to new work', 'Invite the visitor to make contact.'),
        ],
      },
      {
        name: 'About',
        route: '/about',
        purpose: 'Background, skills and approach.',
        sections: [
          section('about', 'About me', 'A few paragraphs of background.'),
          section('features', 'Toolbox', 'Technologies and practices.', [
            ['Languages', 'TypeScript, Python, SQL.'],
            ['Platforms', 'Linux, containers, cloud.'],
            ['Practices', 'Testing, review, documentation.'],
          ]),
        ],
      },
      {
        name: 'Contact',
        route: '/contact',
        purpose: 'A working contact form with client-side validation.',
        sections: [section('contact', 'Get in touch', 'A form with name, email and message.')],
      },
    ],
    palette: palette('dark', '#19d3f3', '#d7f542'),
    headingFont: "'Space Grotesk', system-ui, sans-serif",
  },

  business: {
    category: 'business',
    label: 'Business website',
    description: 'Services, proof and contact details for a small company.',
    examplePrompts: [
      'Build a website for a family-run landscaping business with a services list, a gallery and a contact form.',
    ],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Explain the business and drive enquiries.',
        sections: [
          section('hero', 'Reliable work, done properly.', 'Who you help and why it matters.'),
          section('features', 'Services', 'The main things you offer.', [
            ['Service one', 'What it includes and who it suits.'],
            ['Service two', 'What it includes and who it suits.'],
            ['Service three', 'What it includes and who it suits.'],
          ]),
          section('steps', 'How it works', 'Three steps from enquiry to delivery.'),
          section('faq', 'Common questions', 'Answers to the questions you get most.'),
          section('cta', 'Ready to start?', 'Invite the visitor to get in touch.'),
        ],
      },
      {
        name: 'Services',
        route: '/services',
        purpose: 'Detail each service.',
        sections: [section('features', 'What we do', 'Detail for each service.')],
      },
      {
        name: 'Contact',
        route: '/contact',
        purpose: 'Contact form and details.',
        sections: [section('contact', 'Contact us', 'Form and opening hours.')],
      },
    ],
    palette: palette('light', '#1f6feb', '#ff8a24'),
    headingFont: "'Fraunces', Georgia, serif",
  },

  'landing-page': {
    category: 'landing-page',
    label: 'Landing page',
    description: 'A single focused page built around one call to action.',
    examplePrompts: [
      'Build a landing page for a productivity app with a hero, feature list, pricing and an email signup.',
    ],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Convert a visitor into a signup.',
        sections: [
          section('hero', 'Ship faster with less busywork.', 'The one-line promise.'),
          section('features', 'Why it works', 'Three concrete benefits.', [
            ['Faster setup', 'Get running in minutes.'],
            ['Fewer mistakes', 'Guardrails where they matter.'],
            ['Clear reporting', 'Know what actually happened.'],
          ]),
          section('steps', 'How it works', 'Three steps.'),
          section('pricing', 'Pricing', 'Plan comparison.'),
          section('faq', 'Questions', 'Objection handling.'),
          section('cta', 'Start free', 'Email capture.'),
        ],
      },
    ],
    palette: palette('dark', '#d7f542', '#9b5cff'),
    headingFont: "'Space Grotesk', system-ui, sans-serif",
  },

  blog: {
    category: 'blog',
    label: 'Blog',
    description: 'An article index and post layout with readable typography.',
    examplePrompts: [
      'Build a minimal blog with a post list, reading-friendly typography and an about page.',
    ],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Index of recent writing.',
        sections: [
          section('hero', 'Notes and writing', 'What this blog is about.'),
          section('posts', 'Recent posts', 'Article list.', [
            ['Getting started', 'An introduction to the topic.'],
            ['A worked example', 'Walking through a real case.'],
            ['Common mistakes', 'What to avoid.'],
          ]),
        ],
      },
      {
        name: 'About',
        route: '/about',
        purpose: 'Who writes here.',
        sections: [section('about', 'About', 'A short biography.')],
      },
    ],
    palette: palette('light', '#0f766e', '#ff8a24'),
    headingFont: "'Fraunces', Georgia, serif",
  },

  ecommerce: {
    category: 'ecommerce',
    label: 'E-commerce storefront',
    description: 'A product grid and detail layout. No payment processing included.',
    examplePrompts: [
      'Build a storefront for a ceramics studio with a product grid, product detail pages and a cart summary.',
    ],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Show the range and route to products.',
        sections: [
          section('hero', 'Made by hand, built to last.', 'Store positioning.'),
          section('products', 'Shop', 'Product grid.', [
            ['Stoneware mug', 'Sample product — replace with your own.'],
            ['Speckled bowl', 'Sample product — replace with your own.'],
            ['Tall vase', 'Sample product — replace with your own.'],
          ]),
          section('features', 'Shipping and returns', 'Practical policies.', [
            ['Shipping', 'Dispatch times and costs.'],
            ['Returns', 'How returns work.'],
          ]),
        ],
      },
      {
        name: 'Products',
        route: '/products',
        purpose: 'Full catalogue.',
        sections: [section('products', 'All products', 'Complete product list.')],
      },
    ],
    palette: palette('light', '#b45309', '#19d3f3'),
    headingFont: "'Fraunces', Georgia, serif",
  },

  'saas-dashboard': {
    category: 'saas-dashboard',
    label: 'SaaS dashboard',
    description: 'A data-focused shell with metric cards and a chart placeholder.',
    examplePrompts: [
      'Build an analytics dashboard with a sidebar, metric cards and a usage chart.',
    ],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Overview of the product and its main metrics.',
        sections: [
          section('hero', 'Everything in one view.', 'Product summary.'),
          section('features', 'What you get', 'Capability overview.', [
            ['Live metrics', 'Numbers update as events arrive.'],
            ['Alerts', 'Get told when something moves.'],
            ['Exports', 'Take your data with you.'],
          ]),
          section('cta', 'Try the dashboard', 'Signup call to action.'),
        ],
      },
    ],
    palette: palette('dark', '#19d3f3', '#9b5cff'),
    headingFont: "'Space Grotesk', system-ui, sans-serif",
  },

  education: {
    category: 'education',
    label: 'Educational website',
    description: 'A course outline with modules, schedule and enrolment.',
    examplePrompts: [
      'Build a course website for an introductory Python class with a syllabus, schedule and enrolment form.',
    ],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Describe the course and who it is for.',
        sections: [
          section('hero', 'Learn to build real software.', 'Course promise and level.'),
          section('features', 'What you will learn', 'Learning outcomes.', [
            ['Foundations', 'Core concepts and vocabulary.'],
            ['Practice', 'Exercises with feedback.'],
            ['Project', 'A finished piece of work.'],
          ]),
          section('schedule', 'Schedule', 'Session by session plan.'),
          section('cta', 'Enrol', 'Enrolment call to action.'),
        ],
      },
      {
        name: 'Syllabus',
        route: '/syllabus',
        purpose: 'Full syllabus.',
        sections: [section('steps', 'Syllabus', 'Module breakdown.')],
      },
    ],
    palette: palette('light', '#4338ca', '#d7f542'),
    headingFont: "'Fraunces', Georgia, serif",
  },

  event: {
    category: 'event',
    label: 'Event registration',
    description: 'Event details, agenda and a registration form.',
    examplePrompts: [
      'Build a registration page for a one-day security conference with an agenda and signup form.',
    ],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Event details and registration.',
        sections: [
          section('hero', 'A one-day conference.', 'Date, location and theme.'),
          section('schedule', 'Agenda', 'Talks through the day.', [
            ['09:00 — Opening', 'Welcome and framing.'],
            ['11:00 — Session', 'A practical deep dive.'],
            ['15:00 — Workshop', 'Hands-on session.'],
          ]),
          section('faq', 'Practicalities', 'Travel, food and accessibility.'),
          section('cta', 'Register', 'Registration form.'),
        ],
      },
    ],
    palette: palette('dark', '#ff8a24', '#19d3f3'),
    headingFont: "'Space Grotesk', system-ui, sans-serif",
  },

  documentation: {
    category: 'documentation',
    label: 'Documentation site',
    description: 'A docs layout with navigation and content sections.',
    examplePrompts: [
      'Build a documentation site for a small API with a sidebar, getting started guide and reference pages.',
    ],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Entry point into the docs.',
        sections: [
          section('hero', 'Documentation', 'What this project does and where to start.'),
          section('steps', 'Getting started', 'Install, configure, run.', [
            ['Install', 'Add the dependency.'],
            ['Configure', 'Set the required options.'],
            ['Run', 'Start it up.'],
          ]),
          section('faq', 'Troubleshooting', 'Frequent problems.'),
        ],
      },
      {
        name: 'Reference',
        route: '/reference',
        purpose: 'API reference.',
        sections: [section('features', 'Reference', 'Endpoints and options.')],
      },
    ],
    palette: palette('light', '#0f172a', '#19d3f3'),
    headingFont: "'Space Grotesk', system-ui, sans-serif",
  },

  custom: {
    category: 'custom',
    label: 'Custom application',
    description: 'A flexible starting point when nothing else fits.',
    examplePrompts: ['Build a website for my community garden with events, photos and a join form.'],
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Landing page for the project.',
        sections: [
          section('hero', 'Welcome', 'What this is and who it is for.'),
          section('features', 'Highlights', 'The main things to know.', [
            ['First point', 'A short explanation.'],
            ['Second point', 'A short explanation.'],
            ['Third point', 'A short explanation.'],
          ]),
          section('cta', 'Get involved', 'A call to action.'),
        ],
      },
      {
        name: 'Contact',
        route: '/contact',
        purpose: 'Contact form.',
        sections: [section('contact', 'Contact', 'Send a message.')],
      },
    ],
    palette: palette('dark', '#19d3f3', '#ff8a24'),
    headingFont: "'Space Grotesk', system-ui, sans-serif",
  },
};

export function templateFor(category: ProjectCategory): TemplateDefinition {
  return TEMPLATES[category] ?? TEMPLATES.custom;
}

export function templateSummaries() {
  return Object.values(TEMPLATES).map((t) => ({
    category: t.category,
    label: t.label,
    description: t.description,
    examplePrompts: t.examplePrompts,
    pageCount: t.pages.length,
  }));
}

export function designTokensFrom(template: TemplateDefinition, theme: ProjectTheme): DesignTokens {
  return {
    background: template.palette.background,
    surface: template.palette.surface,
    text: template.palette.text,
    textMuted: template.palette.textMuted,
    primary: template.palette.primary,
    accent: template.palette.accent,
    headingFont: template.headingFont,
    bodyFont: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    radius: '14px',
    theme,
  };
}

/**
 * Builds a complete, validated specification from a template plus the user's
 * brief. Used directly by the template engine and as the seed structure for the
 * AI planner.
 */
export function specFromTemplate(input: {
  title: string;
  description: string;
  category: ProjectCategory;
  theme: ProjectTheme;
  framework: WebsiteSpec['framework'];
  analysis?: BriefAnalysis;
}): WebsiteSpec {
  const template = templateFor(input.category);
  const design = designTokensFrom(template, input.theme);

  const pages: SitePage[] = template.pages.map((p) => ({
    name: p.name,
    route: p.route,
    purpose: p.purpose,
    sections: p.sections.map((s) => s.heading),
  }));

  return {
    title: input.title,
    description: input.description,
    audience: input.analysis?.audience ?? 'general visitors',
    framework: input.framework,
    theme: input.theme,
    pages,
    design,
    components: [
      {
        name: 'Section',
        path: 'src/components/Section.tsx',
        responsibility: 'Shared section wrapper with a heading and optional intro text.',
        props: ['heading', 'intro', 'children'],
      },
      {
        name: 'Card',
        path: 'src/components/Card.tsx',
        responsibility: 'Renders a title and body pair, used by feature and project grids.',
        props: ['title', 'body'],
      },
      {
        name: 'ContactForm',
        path: 'src/components/ContactForm.tsx',
        responsibility: 'Accessible contact form with client-side validation.',
        props: [],
      },
      {
        name: 'SampleContentNotice',
        path: 'src/components/SampleContentNotice.tsx',
        responsibility:
          'Discloses that placeholder content was generated and should be replaced.',
        props: [],
      },
    ],
    dataRequirements: ['All content is static; no backend is required.'],
    interactions: ['Hash-based navigation between pages.', 'Contact form validation.'],
    responsive: [
      'Single column below 640px.',
      'Two columns between 640px and 1024px.',
      'Full multi-column layout above 1024px.',
    ],
    accessibility: [
      'Semantic landmarks: header, nav, main, footer.',
      'Every form control has a visible label.',
      'Focus styles are always visible.',
      'Colour contrast meets WCAG AA.',
      'Motion respects prefers-reduced-motion.',
    ],
    filePlan: [
      'src/pages/*.tsx',
      'src/components/*.tsx',
      'src/styles/theme.css',
    ],
    dependencies: [],
    validationCriteria: [
      'The project installs and builds without errors.',
      'Every route in the specification renders.',
      'No placeholder "TODO" text remains.',
    ],
    sampleContent: true,
  };
}

/** Component name for a page, matching what the scaffold imports. */
export function pageComponentName(page: SitePage): string {
  return toComponentName(page.name);
}
