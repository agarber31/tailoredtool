// ============================================================
// Tailored Tool — widget generation pipeline
// Three passes: design plan -> build -> critique & repair
// ============================================================

const CRAFT_DOCTRINE = `
You are a principal-level product engineer and design lead with twenty years of shipped work — the person a studio brings in when a build has to look and feel expensive. You write vanilla HTML, CSS and JavaScript by hand. No frameworks, no build step, no libraries.

Everything you produce must pass this bar: a senior engineer reading the source should see intent in every line, and a design director looking at the result should not be able to tell it was generated.

## The tells you must avoid
These patterns instantly mark work as machine-made. Do not produce them.
- Generic gradient buttons in violet-to-blue, and glassmorphism used as a substitute for a real idea.
- Uniform 8px radius on every element, uniform shadows, everything the same visual weight.
- Emoji as iconography. Draw inline SVG icons, sized to the type, with consistent stroke weight.
- Copy that sells instead of explains ("Unlock the power of...", "Seamlessly...", "Elevate your...").
- Three feature cards in a row with a centered icon above a heading above two lines of grey text.
- Animating everything. Motion is a tool for feedback and hierarchy, not decoration.
- Comments that narrate the obvious. Dead code, unused CSS, or console.log left in.

## Craft requirements
- Derive the entire visual system from the client's own brand — their colors, their type, their tone. The widget must look native to their site, as if their own designer built it.
- Set a real type scale. Deliberate weights and line-heights. Body copy 15-16px, comfortable measure, never grey-on-grey mush.
- Spacing on a consistent rhythm. Optical alignment beats mathematical alignment when they disagree.
- Every interactive element gets hover, focus-visible and active states. Focus rings must be visible and must not be removed.
- Motion: 150-250ms, ease-out for entrances. Honour prefers-reduced-motion.
- Handle every state: idle, loading, empty, error, success. Loading must not shift layout.
- Accessible by construction: semantic elements, labelled controls, aria-live for async output, contrast at least 4.5:1, full keyboard operation.
- Responsive from 320px up. No horizontal scroll. Touch targets at least 44px.
- Namespace every class and CSS custom property with a unique prefix so nothing collides with the host page. Never style bare element selectors or use !important.

## Copy
Words are design material. Plain verbs, sentence case, no filler. A button says exactly what happens when it is pressed. Errors say what went wrong and what to do next. Empty states invite action. Never write in the voice of a salesperson.

## Output contract
One self-contained widget: a <style> block, the markup, and a <script> block. It must run when pasted into any page. No external fonts, no CDNs, no inline event handler attributes — bind listeners in script.
`;

const PLAN_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['palette','type_system','layout','signature','motion','copy_voice','states'],
  properties:{
    palette:{ type:'array', items:{ type:'object', additionalProperties:false,
      required:['name','hex','use'], properties:{
        name:{type:'string'}, hex:{type:'string'}, use:{type:'string'} } },
      description:'4-6 named colors derived from the client brand.' },
    type_system:{ type:'string', description:'Font stacks and the full type scale with weights and line-heights. Use system/web-safe stacks only.' },
    layout:{ type:'string', description:'Concrete layout: placement on their page, dimensions, structure, responsive behaviour.' },
    signature:{ type:'string', description:"The one memorable detail, justified by the needs of their customers." },
    motion:{ type:'string', description:'Specific motion decisions with durations and easing.' },
    copy_voice:{ type:'string', description:'How the widget speaks, matched to their brand tone, with 2 sample lines.' },
    states:{ type:'string', description:'How idle, loading, empty, error and success each look.' }
  }
};

async function openai(env, { system, user, schema, maxTokens = 4000, temperature = 0.7 }) {
  const bodyObj = {
    model: 'gpt-4o',
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role:'system', content: system },
      { role:'user', content: user }
    ]
  };
  if (schema) {
    bodyObj.response_format = {
      type:'json_schema',
      json_schema:{ name:'out', strict:true, schema }
    };
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify(bodyObj)
  });
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('generation failed');
  return content;
}

function brandBrief(brand, site, spec) {
  return `CLIENT
Business: ${site.title || 'unknown'}
What they do: ${site.description || spec.business_summary}
Website: ${spec.source_url || 'n/a'}
Platform: ${site.platform || 'unknown'}

THEIR EXISTING BRAND (extracted from their live site — build the widget to match this, not to a generic style)
Colors found: ${(brand.colors || []).join(', ') || 'none detected — derive a palette that suits the business'}
Fonts found: ${(brand.fonts || []).join(', ') || 'none detected — choose a fitting system stack'}
Their headings: ${(site.headings || []).slice(0,10).join(' | ')}
Their navigation: ${(site.navLinks || []).slice(0,12).join(' | ')}
Their own words: ${(site.bodyText || []).slice(0,8).join(' ')}

THE TOOL TO BUILD
Name: ${spec.tool_name}
Tagline: ${spec.tagline}
What it does: ${spec.what_it_does}
Where it lives: ${spec.where_it_goes}
Problem it solves: ${spec.problem_solved}
Features: ${(spec.features || []).join('; ')}
Tier: ${spec.tier}`;
}

export async function generateWidget(env, { brand, site, spec }) {
  const brief = brandBrief(brand, site, spec);

  // Pass 1 — design plan
  const planRaw = await openai(env, {
    system: `${CRAFT_DOCTRINE}

Right now you are only planning, not writing code.

Produce a design plan for one embeddable widget for this specific client. Ground every decision in their business and their existing brand. State the single signature element — the one detail this widget will be remembered for — and justify it in terms of their customers, not in terms of aesthetics.

If any part of your plan is what you would produce for any other client in this industry, replace it with something specific to this one.`,
    user: brief,
    schema: PLAN_SCHEMA,
    maxTokens: 1600,
    temperature: 0.85
  });
  const plan = JSON.parse(planRaw);

  const planText = `DESIGN PLAN (follow exactly)
Palette: ${plan.palette.map(c => `${c.name} ${c.hex} — ${c.use}`).join('; ')}
Type: ${plan.type_system}
Layout: ${plan.layout}
Signature element: ${plan.signature}
Motion: ${plan.motion}
Voice: ${plan.copy_voice}
States: ${plan.states}`;

  // Pass 2 — build
  const draft = await openai(env, {
    system: `${CRAFT_DOCTRINE}

Now write the widget. Follow the supplied design plan exactly — every color, every type decision, every interaction comes from the plan.

The widget calls its backend like this, and nowhere else:

  const res = await fetch(TT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: userText, history: conversationHistory })
  });
  const data = await res.json();   // { reply: "..." }

Declare TT_ENDPOINT at the top of the script as a const with the placeholder value "__TT_ENDPOINT__".

Return ONLY the widget code — a <style> block, the markup, and a <script> block. No markdown fences, no commentary before or after. Production quality on first read: no placeholders, no TODOs.`,
    user: `${brief}\n\n${planText}`,
    maxTokens: 6000,
    temperature: 0.6
  });

  // Pass 3 — critique and repair
  const finalCode = await openai(env, {
    system: `${CRAFT_DOCTRINE}

You are reviewing a colleague's widget before it ships to a paying client. You are the last set of eyes.

Go through it against the doctrine above. Find every shortfall: generic patterns, missing states, accessibility failures, contrast problems, layout that breaks under 360px, motion that ignores reduced-motion, class names that could collide with the host page, copy that sells instead of explains, dead code.

Return the corrected widget in full — not a diff, not a list of notes. Fix everything you found. Sections that were already right stay exactly as they were.

Return ONLY the code. No markdown fences, no commentary.`,
    user: `${brief}\n\n${planText}\n\nWIDGET TO REVIEW:\n${draft}`,
    maxTokens: 6000,
    temperature: 0.35
  });

  const clean = finalCode
    .replace(/^\s*```(?:html|HTML)?\s*/,'')
    .replace(/\s*```\s*$/,'')
    .trim();

  return { plan, code: clean };
}
