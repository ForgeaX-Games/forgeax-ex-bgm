/** 滑杆右侧读数：点击后变成数字框，方便精确定位。 */
export function enablePreciseOutput(
  input: HTMLInputElement,
  output: HTMLOutputElement,
  format: () => string,
): void {
  if (output.dataset.precise === '1') return;
  output.dataset.precise = '1';
  output.tabIndex = 0;
  output.title = '点击输入精确值';
  const beginEdit = (): void => {
    if (output.parentElement?.querySelector('.slider-precise')) return;
    const box = document.createElement('input');
    box.type = 'number';
    box.className = 'slider-precise';
    box.value = input.value;
    box.min = input.min;
    box.step = input.step;
    output.replaceWith(box);
    box.focus();
    box.select();
    const commit = (): void => {
      const next = Number(box.value);
      if (Number.isFinite(next)) {
        if (next > Number(input.max)) input.max = String(next);
        if (next < Number(input.min)) input.min = String(next);
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      box.replaceWith(output);
      output.textContent = format();
    };
    box.addEventListener('blur', commit);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') box.blur();
      if (event.key === 'Escape') {
        box.replaceWith(output);
        output.textContent = format();
      }
    });
  };
  output.addEventListener('click', beginEdit);
  output.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      beginEdit();
    }
  });
}

export function showToast(msg: string, type = ''): void {
  const t = document.getElementById('toast') as HTMLElement & { _tid?: ReturnType<typeof setTimeout> };
  if (!t) return;
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.add('hidden'), 3500);
}
