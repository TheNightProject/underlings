(() => {
  const orange = (s) => `\x1b[38;5;173m${s}\x1b[0m`;
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  const green = (s) => `\x1b[32m${s}\x1b[0m`;

  function cursor() {
    const dot = document.createElement('div');
    dot.id = 'demo-cursor';
    dot.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))';
    dot.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l15 9-6.5 1.6L9.5 19z" fill="#fff" stroke="#1a202b" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid rgba(79,107,237,.9);z-index:2147483646;pointer-events:none;opacity:0;transform:scale(.4)';
    document.documentElement.append(dot, ring);
    addEventListener('mousemove', (e) => { dot.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', (e) => {
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      ring.animate([{ opacity: 0.9, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 420, easing: 'ease-out' });
    }, true);
  }

  const wrap = (text, width) => {
    const out = [];
    let line = '';
    for (const word of text.split(' ')) {
      if ((line + ' ' + word).trim().length > width) { out.push(line); line = word; } else line = (line + ' ' + word).trim();
    }
    return [...out, line];
  };

  function script(cols) {
    const width = Math.min(cols - 2, 64);
    const para = (text, first = '  ', rest = '  ') => wrap(text, width - 2).map((l, i) => (i ? rest : first) + l).join('\r\n');
    const bullet = orange('●') + ' ';
    const box = (inner) => [`╭${'─'.repeat(width)}╮`, ...inner.map((l) => `│ ${l}${' '.repeat(Math.max(0, width - 1 - l.replace(/\x1b\[[\d;]*m/g, '').length))}│`), `╰${'─'.repeat(width)}╯`].join('\r\n');
    return [
      { text: `${box([`${orange('✻')} ${bold('Welcome to Claude Code')}`, '', dim('/help for help, /status for your setup'), dim('cwd: ~/work/acme')])}\r\n\r\n`, wait: 300 },
      { type: '> which of my agents are stuck?', wait: 300 },
      { text: `\r\n\r\n${bullet}Three agents are waiting on you.\r\n\r\n`, wait: 350 },
      { text: `${para('ABC-113 asks which limit wins when a tenant has several tokens.')}\r\n`, wait: 300 },
      { text: `${para('mobile!15 wants to run npm install for its review.')}\r\n`, wait: 300 },
      { text: `${para('cli!3 has waited 58 minutes to push its fix for ABC-105.')}\r\n\r\n`, wait: 450 },
      { type: '> review acme/engine!7 and queue what you find', wait: 300 },
      { text: `\r\n\r\n${bullet}Read(src/token.ts)\r\n${dim('  ⎿  Read 17 lines')}\r\n\r\n`, wait: 450 },
      { text: `${para('Queued 5 findings on acme/engine!7 for ABC-101. The worst: a revoked token stays valid until the cache is cleared.', bullet, '  ')}\r\n\r\n`, wait: 250 },
      { text: `${green('✔')} Post them from the Review queue.\r\n\r\n`, wait: 0 },
      { text: `${box(['> '])}\r\n${dim('  ? for shortcuts')}`, wait: 0 },
    ];
  }

  function terminal() {
    const listeners = [];
    let started = false;
    const emit = (data) => listeners.forEach((fn) => fn(data));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function play(cols) {
      for (const step of script(cols)) {
        if (step.type) for (const ch of step.type) { emit(ch); await sleep(22); }
        else emit(step.text);
        await sleep(step.wait);
      }
    }
    window.ccTerminal = {
      onData: (fn) => listeners.push(fn),
      write() {},
      resize() {},
      attach(cols) { if (!started) { started = true; play(cols); } },
    };
  }

  terminal();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cursor); else cursor();
})();
