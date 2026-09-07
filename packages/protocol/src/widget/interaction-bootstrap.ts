/** Portable, business-user input card for recoverable `ctx.elicit` results. */
export const WIDGET_INTERACTION_SOURCE: string = `
  function removeInteractionCard() {
    const existing = document.getElementById('noodle-interaction-card');
    if (existing) existing.remove();
  }
  function interactionLabel(name, schema) {
    if (schema && typeof schema.title === 'string') return schema.title;
    return String(name).replace(/[_-]+/g, ' ').replace(/(^|\\s)\\S/g, (c) => c.toUpperCase());
  }
  function addInteractionChoice(select, value, label) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(label);
    select.appendChild(option);
  }
  function interactionControl(name, schema, required) {
    let control;
    const choices = Array.isArray(schema.enum)
      ? schema.enum.map((value) => ({ value, label: value }))
      : Array.isArray(schema.oneOf)
        ? schema.oneOf.map((choice) => ({ value: choice.const, label: choice.title }))
        : null;
    if (schema.type === 'array') {
      control = document.createElement('div');
      control.setAttribute('role', 'group');
      const itemChoices = schema.items && Array.isArray(schema.items.enum)
        ? schema.items.enum.map((value) => ({ value, label: value }))
        : schema.items && Array.isArray(schema.items.anyOf)
          ? schema.items.anyOf.map((choice) => ({ value: choice.const, label: choice.title }))
          : [];
      for (const choice of itemChoices) {
        const optionLabel = document.createElement('label');
        optionLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:400';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = String(choice.value);
        checkbox.checked = Array.isArray(schema.default) && schema.default.includes(choice.value);
        optionLabel.append(checkbox, document.createTextNode(String(choice.label)));
        control.appendChild(optionLabel);
      }
      control.dataset.minItems = String(typeof schema.minItems === 'number' ? schema.minItems : required ? 1 : 0);
      if (typeof schema.maxItems === 'number') control.dataset.maxItems = String(schema.maxItems);
    } else if (choices) {
      control = document.createElement('select');
      addInteractionChoice(control, '', 'Choose an option');
      for (const choice of choices) addInteractionChoice(control, choice.value, choice.label);
    } else if (schema.type === 'boolean') {
      control = document.createElement('input');
      control.type = 'checkbox';
    } else if (schema.type === 'number' || schema.type === 'integer') {
      control = document.createElement('input');
      control.type = 'number';
      if (schema.type === 'integer') control.step = '1';
      if (typeof schema.minimum === 'number') control.min = String(schema.minimum);
      if (typeof schema.maximum === 'number') control.max = String(schema.maximum);
    } else {
      control = document.createElement('input');
      control.type = schema.format === 'email' ? 'email' : schema.format === 'date' ? 'date' : schema.format === 'date-time' ? 'datetime-local' : 'text';
      if (typeof schema.minLength === 'number') control.minLength = schema.minLength;
      if (typeof schema.maxLength === 'number') control.maxLength = schema.maxLength;
    }
    control.name = name;
    control.required = required && control.type !== 'checkbox' && schema.type !== 'array';
    if (schema.default !== undefined && schema.type !== 'array') {
      if (control.type === 'checkbox') control.checked = Boolean(schema.default);
      else control.value = String(schema.default);
    }
    return control;
  }
  function interactionValue(control, schema) {
    if (schema.type === 'array') {
      return Array.from(control.querySelectorAll('input[type="checkbox"]:checked')).map((item) => item.value);
    }
    if (schema.type === 'boolean') return Boolean(control.checked);
    if (schema.type === 'number' || schema.type === 'integer') return Number(control.value);
    return control.value;
  }
  function renderInteractionCard(data) {
    const request = data && data.code === 'interaction_unavailable' && data.interaction === 'input'
      ? data.request
      : null;
    const interaction = data && data._meta && data._meta.noodle && data._meta.noodle.interaction;
    if (!request || !interaction || typeof interaction.tool !== 'string') {
      removeInteractionCard();
      return;
    }
    removeInteractionCard();
    const schema = request.requestedSchema || {};
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const card = document.createElement('section');
    card.id = 'noodle-interaction-card';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Details needed');
    card.style.cssText = 'box-sizing:border-box;margin:12px;padding:20px;border:1px solid var(--color-border-secondary,#d8dee8);border-radius:16px;background:var(--color-background-primary,#fff);color:var(--color-text-primary,#172033);box-shadow:0 10px 30px rgba(23,32,51,.10);font:14px/1.45 system-ui,sans-serif';
    const eyebrow = document.createElement('div');
    eyebrow.textContent = 'DETAILS NEEDED';
    eyebrow.style.cssText = 'margin-bottom:6px;color:var(--color-text-secondary,#667085);font-size:11px;font-weight:700;letter-spacing:.08em';
    const title = document.createElement('h2');
    title.textContent = 'A few details before we continue';
    title.style.cssText = 'margin:0 0 6px;font-size:18px;line-height:1.3';
    const message = document.createElement('p');
    message.textContent = typeof request.message === 'string' ? request.message : 'Please complete the details below.';
    message.style.cssText = 'margin:0 0 16px;color:var(--color-text-secondary,#475467)';
    const form = document.createElement('form');
    form.style.cssText = 'display:grid;gap:14px';
    const controls = {};
    for (const name of Object.keys(properties)) {
      const fieldSchema = properties[name] || {};
      const field = document.createElement('label');
      field.style.cssText = 'display:grid;gap:6px;font-weight:600';
      const label = document.createElement('span');
      label.textContent = interactionLabel(name, fieldSchema) + (required.includes(name) ? ' *' : '');
      const control = interactionControl(name, fieldSchema, required.includes(name));
      control.style.cssText = control.type === 'checkbox'
        ? 'width:18px;height:18px'
        : 'box-sizing:border-box;width:100%;min-height:42px;padding:9px 11px;border:1px solid var(--color-border-secondary,#cbd5e1);border-radius:10px;background:var(--color-background-primary,#fff);color:inherit;font:inherit';
      controls[name] = { control, schema: fieldSchema };
      field.append(label, control);
      if (typeof fieldSchema.description === 'string') {
        const hint = document.createElement('small');
        hint.textContent = fieldSchema.description;
        hint.style.cssText = 'color:var(--color-text-secondary,#667085);font-weight:400';
        field.appendChild(hint);
      }
      form.appendChild(field);
    }
    const submit = document.createElement('button');
    submit.id = 'noodle-interaction-submit';
    submit.type = 'submit';
    submit.textContent = 'Continue';
    submit.style.cssText = 'min-height:42px;padding:9px 16px;border:0;border-radius:10px;background:var(--color-background-accent,#2563eb);color:var(--color-text-on-accent,#fff);font:inherit;font-weight:700;cursor:pointer';
    form.appendChild(submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;
      const content = {};
      for (const name of Object.keys(controls)) {
        const item = controls[name];
        const value = interactionValue(item.control, item.schema);
        if (item.schema.type === 'array') {
          const minItems = Number(item.control.dataset.minItems || 0);
          const maxItems = item.control.dataset.maxItems ? Number(item.control.dataset.maxItems) : Infinity;
          if (value.length < minItems || value.length > maxItems) {
            status('Choose the requested number of options before continuing.');
            return;
          }
        }
        content[name] = value;
      }
      const args = Object.assign({}, globalThis.__noodleInput || {});
      delete args.__noodleInteraction;
      const responses = Object.assign({}, interaction.responses || {}, {
          [request.id]: { action: 'accept', content },
        });
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      submit.textContent = 'Continuing…';
      Promise.resolve(app.callServerTool({
        name: interaction.tool,
        arguments: args,
        _meta: { noodle: { interaction: { responses } } },
      }))
        .then((result) => bind(fromResult(result)))
        .catch(() => status('We could not continue. Please review the details and try again.'))
        .then(() => {
          submit.disabled = false;
          submit.removeAttribute('aria-busy');
          submit.textContent = 'Continue';
        });
    });
    card.append(eyebrow, title, message, form);
    document.body.prepend(card);
  }
`;
