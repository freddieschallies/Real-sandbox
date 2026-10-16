# Instruction videos: drives the test drive (made-up company) in a browser and records it, with a
# title card, a caption band under the app, and a visible pointer for every tap.
import asyncio, os, re, subprocess
from playwright.async_api import async_playwright

V = os.path.dirname(os.path.abspath(__file__))
BAND = 150

CSS_T = """
#root {{ height: calc(100vh - {band}px) !important; }}
#vband {{ position: fixed; left: 0; right: 0; bottom: 0; height: {band}px; background: #0B0D10; border-top: 4px solid #F07A1A;
  display: flex; align-items: center; gap: {gap}px; padding: 0 {pad}px; box-sizing: border-box; z-index: 2147483000; pointer-events: none;
  font-family: Inter, 'DejaVu Sans', sans-serif; }}
#vstep {{ flex: none; color: #0B0D10; background: #F07A1A; font-weight: 800; font-size: {stepf}px; border-radius: 999px; padding: 8px 18px; }}
#vtext {{ color: #F4F6F8; font-size: {font}px; line-height: 1.3; font-weight: 600; transition: opacity .25s; }}
#vtext small {{ display: block; color: #AEB6C0; font-size: {small}px; font-weight: 500; margin-top: 4px; }}
#vcard {{ position: fixed; inset: 0; z-index: 2147483600; background: radial-gradient(circle at 30% 20%, #23344F, #0B0D10 70%); display: flex; flex-direction: column;
  justify-content: center; padding: 0 9vw; gap: 18px; font-family: Inter, 'DejaVu Sans', sans-serif; transition: opacity .6s; pointer-events: none; }}
#vcard .k {{ color: #F07A1A; font-weight: 800; font-size: 26px; letter-spacing: .14em; text-transform: uppercase; }}
#vcard .t {{ color: #fff; font-weight: 800; font-size: {title}px; line-height: 1.08; }}
#vcard .s {{ color: #C9D2DC; font-size: {font}px; line-height: 1.4; max-width: 1000px; }}
#vcard ul {{ color: #C9D2DC; font-size: {small2}px; line-height: 1.55; margin: 6px 0 0 0; padding-left: 30px; }}
#vptr {{ position: fixed; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; background: rgba(240,122,26,.35); border: 3px solid #fff;
  box-shadow: 0 0 0 2px rgba(0,0,0,.5); z-index: 2147483500; pointer-events: none; left: 50%; top: 40%; transition: left .55s ease, top .55s ease, transform .15s, opacity .3s; }}
#vptr.down {{ transform: scale(.7); background: rgba(240,122,26,.8); }}
"""

JS = """
(css) => {
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  const band = document.createElement('div'); band.id = 'vband'; band.innerHTML = '<div id="vstep" style="display:none"></div><div id="vtext"></div>'; document.body.appendChild(band);
  const p = document.createElement('div'); p.id = 'vptr'; p.style.opacity = '0'; document.body.appendChild(p);
  // The test drive's own bar (switch people, guide) is not part of the real app: hide it.
  const hide = () => {
    for (const el of document.querySelectorAll('#root div')) {
      const t = el.innerText || '';
      if (window.__showBar) { if (el.dataset.vhid) { el.style.display = ''; delete el.dataset.vhid; } continue; }
      if (/^view as/i.test(t.trim()) && el.offsetHeight < 80 && el.offsetHeight > 20 && /guide/i.test(t)) { el.style.display = 'none'; el.dataset.vhid = '1'; }
    }
  };
  setInterval(hide, 200);
  window.dispatchEvent(new Event('resize'));
}
"""

def secs_for(text):
    words = len(re.sub(r'<[^>]+>', ' ', text).split())
    return max(2.6, words * 0.33 + 1.0)

class Video:
    def __init__(self, name, width=1280, height=800, phone=False):
        self.name, self.w, self.h = name, width, height
        self.band = 200 if phone else BAND
        self.css = CSS_T.format(band=self.band, gap=12 if phone else 22, pad=18 if phone else 36, font=23 if phone else 29, small=17 if phone else 21,
                                stepf=16 if phone else 22, title=44 if phone else 64, small2=20 if phone else 26)
        self.step = 0

    async def __aenter__(self):
        self.p = await async_playwright().start()
        self.b = await self.p.chromium.launch(executable_path='/opt/pw-browsers/chromium')
        os.makedirs(f'{V}/raw/{self.name}', exist_ok=True)
        for f in os.listdir(f'{V}/raw/{self.name}'): os.remove(f'{V}/raw/{self.name}/{f}')
        self.ctx = await self.b.new_context(viewport={'width': self.w, 'height': self.h}, record_video_dir=f'{V}/raw/{self.name}',
                                            record_video_size={'width': self.w, 'height': self.h})
        self.pg = await self.ctx.new_page()
        self.errs = []
        self.pg.on('pageerror', lambda e: self.errs.append(str(e)[:300]))
        self.files = []
        async def fc(f):
            await f.set_files(self.files.pop(0) if self.files else f'{V}/before.jpg')
        self.pg.on('filechooser', lambda f: asyncio.ensure_future(fc(f)))
        html = open(f'{V}/plain.html').read()
        await self.pg.route('http://localhost:5566/', lambda r: r.fulfill(status=200, content_type='text/html', body=html))
        await self.pg.goto('http://localhost:5566/')
        await self.pg.evaluate(JS, self.css)
        await self.pg.wait_for_timeout(1800)
        return self

    async def __aexit__(self, et=None, ev=None, tb=None):
        if et:
            await self.pg.screenshot(path=f'{V}/dbg_{self.name}_FAIL.png')
            print('FAILED at step', self.step, ':', str(ev)[:200])
        await self.pg.wait_for_timeout(600)
        path = await self.pg.video.path()
        await self.ctx.close(); await self.b.close(); await self.p.stop()
        out = f'{V}/out/{self.name}.mp4'
        os.makedirs(f'{V}/out', exist_ok=True)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', path, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
                        '-movflags', '+faststart', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out], check=True)
        print(self.name, 'errors:', self.errs[:5] or 'none', '->', out)

    # ---- the overlays -------------------------------------------------------------------------
    async def card(self, kicker, title, sub='', bullets=(), hold=None):
        html = f'<div class="k">{kicker}</div><div class="t">{title}</div>' + (f'<div class="s">{sub}</div>' if sub else '') + \
               (('<ul>' + ''.join(f'<li>{b}</li>' for b in bullets) + '</ul>') if bullets else '')
        await self.pg.evaluate("""(h) => { let c = document.getElementById('vcard'); if (!c) { c = document.createElement('div'); c.id = 'vcard'; document.body.appendChild(c); }
          c.innerHTML = h; c.style.opacity = '1'; c.style.display = 'flex'; }""", html)
        await self.pg.wait_for_timeout(int((hold or secs_for(title + ' ' + sub + ' ' + ' '.join(bullets)) + 0.8) * 1000))

    async def uncard(self):
        await self.pg.evaluate("() => { const c = document.getElementById('vcard'); if (c) { c.style.opacity = '0'; setTimeout(() => c.style.display = 'none', 650); } }")
        await self.pg.wait_for_timeout(700)

    async def say(self, text, more='', secs=None, step=True):
        if step: self.step += 1
        await self.pg.evaluate("""([t, m, n]) => { const x = document.getElementById('vtext'); x.style.opacity = 0;
          setTimeout(() => { x.innerHTML = t + (m ? '<small>' + m + '</small>' : ''); x.style.opacity = 1; }, 250);
          const s = document.getElementById('vstep'); if (n) { s.style.display = 'block'; s.textContent = 'Step ' + n; } else s.style.display = 'none'; }""",
                               [text, more, self.step if step else 0])
        await self.pg.wait_for_timeout(int((secs or secs_for(text + ' ' + more)) * 1000))

    async def wait(self, s): await self.pg.wait_for_timeout(int(s * 1000))

    async def become(self, who):
        """Switch to another person in the test drive (behind a card)."""
        await self.pg.evaluate('() => { window.__showBar = true; }'); await self.pg.wait_for_timeout(900)
        await self.pg.locator('div:visible', has_text=re.compile('^View as', re.I)).get_by_text(who, exact=True).first.click(timeout=10000); await self.pg.wait_for_timeout(2200)
        await self.pg.evaluate('() => { window.__showBar = false; }'); await self.pg.wait_for_timeout(300)
        if await self.pg.get_by_text('I have read and accept this policy').count():
            await self.pg.mouse.wheel(0, 20000); await self.pg.get_by_text('I have read and accept this policy').first.click(); await self.pg.wait_for_timeout(1500)
        if await self.pg.get_by_text('Later', exact=True).count(): await self.pg.get_by_text('Later', exact=True).first.click(); await self.pg.wait_for_timeout(400)

    async def start(self, button):
        """From the test drive's first page, open as someone (behind a card)."""
        await self.pg.get_by_text(re.compile('^' + re.escape(button))).first.click(); await self.pg.wait_for_timeout(2800)
        if await self.pg.get_by_text('I have read and accept this policy').count():
            await self.pg.mouse.wheel(0, 20000); await self.pg.get_by_text('I have read and accept this policy').first.click(); await self.pg.wait_for_timeout(1500)
        if await self.pg.get_by_text('Later', exact=True).count(): await self.pg.get_by_text('Later', exact=True).first.click(); await self.pg.wait_for_timeout(400)

    async def tab(self, name):
        # The old caption goes while the screen changes.
        await self.pg.evaluate("() => { document.getElementById('vtext').style.opacity = 0; }")
        t = self.pg.locator('[role="tab"]').filter(has_text=re.compile('^' + name + r'(\s*\d+)?$', re.I))
        if await t.count() and await t.last.is_visible():
            await self.tap(t.last, after=1.4); return
        await self.tap(self.pg.locator('[aria-label^="More:"]'), after=0.6)
        await self.tap(self.pg.get_by_text(re.compile('^' + name + '$', re.I)).last, after=1.4)

    # ---- doing things -------------------------------------------------------------------------
    def loc(self, what, exact=True, nth=0):
        if isinstance(what, str): return self.pg.get_by_text(what, exact=exact).nth(nth)
        return what

    async def point(self, what, exact=True, nth=0):
        l = self.loc(what, exact, nth)
        await l.scroll_into_view_if_needed(timeout=8000)
        bx = await l.bounding_box()
        await self.pg.evaluate("([x, y]) => { const p = document.getElementById('vptr'); p.style.opacity = '1'; p.style.left = x + 'px'; p.style.top = y + 'px'; }",
                               [bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2])
        await self.pg.wait_for_timeout(650)
        return l

    async def tap(self, what, exact=True, nth=0, after=1.0):
        l = await self.point(what, exact, nth)
        await self.pg.evaluate("() => document.getElementById('vptr').classList.add('down')")
        await self.pg.wait_for_timeout(140)
        await l.click()
        await self.pg.evaluate("() => document.getElementById('vptr').classList.remove('down')")
        await self.pg.wait_for_timeout(int(after * 1000))

    async def maybe(self, what, after=1.0, exact=True):
        """Tap it if it is there (some steps depend on the test drive's state)."""
        l = self.loc(what, exact)
        if await l.count() and await l.is_visible():
            await self.tap(l, after=after); return True
        return False

    async def type(self, what, text, delay=55, after=0.5):
        l = await self.point(what)
        await l.click()
        await l.press_sequentially(text, delay=delay)
        await self.pg.wait_for_timeout(int(after * 1000))

    async def label(self, name, text, **kw): await self.type(self.pg.get_by_label(name, exact=True), text, **kw)

    async def scroll(self, dy, x=None, y=None):
        await self.pg.mouse.move(x or self.w / 2, y or (self.h - self.band) / 2)
        steps = 12
        for _ in range(steps):
            await self.pg.mouse.wheel(0, dy / steps); await self.pg.wait_for_timeout(35)
        await self.pg.wait_for_timeout(500)

    async def text(self): return (await self.pg.evaluate('document.getElementById("root").innerText')).lower()

    async def shot(self, n): await self.pg.screenshot(path=f'{V}/dbg_{self.name}_{n}.png')
