'use strict';

const { Plugin, MarkdownView, PluginSettingTab, Setting, Platform } = require('obsidian');

const DEFAULT_SETTINGS = {
  enabled: true,
  minHeadings: 1,
  maxLevel: 6,
  panelWidth: 260,
  closeDelay: 250,
  rightOffset: 14,
};

/** Strip markdown syntax so headings read cleanly in the sidebar. */
function cleanHeading(text) {
  return String(text)
    .replace(/!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1') // wikilinks and embeds
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links
    .replace(/<[^>]+>/g, '') // html tags
    .replace(/(\*+|==|~~|`)/g, '') // emphasis, highlight, strike, code
    .replace(/\s+/g, ' ')
    .trim();
}

class TocController {
  constructor(plugin, view) {
    this.plugin = plugin;
    this.view = view;
    this.headings = [];
    this.signature = '';
    this.activeIdx = -1;
    this.open = false;
    this.closeTimer = null;
    this.raf = null;

    this.onScroll = () => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = null;
        this.updateActive();
      });
    };
    this.onOutside = (e) => {
      if (this.open && !this.root.contains(e.target)) this.setOpen(false);
    };

    this.build();
    this.attach();
    this.applyStyle();
    this.update();
  }

  build() {
    this.root = createDiv({ cls: 'nt-toc is-empty' });
    this.rail = this.root.createDiv({ cls: 'nt-toc-rail' });
    this.panel = this.root.createDiv({ cls: 'nt-toc-panel' });
    this.list = this.panel.createDiv({ cls: 'nt-toc-list' });

    const enter = () => {
      clearTimeout(this.closeTimer);
      if (!Platform.isMobile) this.setOpen(true);
    };
    const leave = () => {
      if (Platform.isMobile) return;
      clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => this.setOpen(false), this.plugin.settings.closeDelay);
    };
    this.rail.addEventListener('mouseenter', enter);
    this.panel.addEventListener('mouseenter', enter);
    this.rail.addEventListener('mouseleave', leave);
    this.panel.addEventListener('mouseleave', leave);

    this.rail.addEventListener('click', (e) => {
      if (Platform.isMobile && !this.open) {
        this.setOpen(true);
        return;
      }
      const tick = e.target.closest('.nt-toc-tick');
      if (tick) this.jump(this.headings[Number(tick.dataset.idx)]);
    });

    this.panel.addEventListener('click', (e) => {
      const item = e.target.closest('.nt-toc-item');
      if (!item) return;
      this.jump(this.headings[Number(item.dataset.idx)]);
      if (Platform.isMobile) this.setOpen(false);
    });
  }

  attach() {
    this.host = this.view.contentEl;
    this.host.classList.add('nt-toc-host');
    this.host.appendChild(this.root);
    this.host.addEventListener('scroll', this.onScroll, true);
    document.addEventListener('pointerdown', this.onOutside, true);
  }

  ensureAttached() {
    if (!this.root.isConnected || this.root.parentElement !== this.view.contentEl) {
      this.host.removeEventListener('scroll', this.onScroll, true);
      this.attach();
    }
  }

  applyStyle() {
    const s = this.plugin.settings;
    this.root.style.setProperty('--nt-panel-width', `${s.panelWidth}px`);
    this.root.style.setProperty('--nt-right', `${s.rightOffset}px`);
  }

  setOpen(value) {
    this.open = value;
    this.root.classList.toggle('is-open', value);
    if (value) this.scrollActiveIntoView();
  }

  readHeadings() {
    const file = this.view.file;
    if (!file) return [];
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const raw = (cache && cache.headings) || [];
    const max = this.plugin.settings.maxLevel;
    const stack = [];
    const out = [];
    for (const h of raw) {
      if (h.level > max) continue;
      const text = cleanHeading(h.heading);
      if (!text) continue;
      while (stack.length && stack[stack.length - 1] >= h.level) stack.pop();
      const depth = stack.length;
      stack.push(h.level);
      out.push({ text, level: h.level, depth, line: h.position.start.line });
    }
    return out;
  }

  update() {
    this.headings = this.readHeadings();
    const sig = JSON.stringify(this.headings) + '|' + this.plugin.settings.minHeadings;
    if (sig !== this.signature) {
      this.signature = sig;
      this.render();
    }
    this.updateActive();
  }

  render() {
    const n = this.headings.length;
    const visible = n > 0 && n >= this.plugin.settings.minHeadings;
    this.root.classList.toggle('is-empty', !visible);
    this.rail.empty();
    this.list.empty();
    if (!visible) return;

    const hostH = this.view.contentEl.clientHeight || 600;
    const tickH = Math.max(5, Math.min(12, Math.floor((hostH * 0.7) / n)));
    this.root.style.setProperty('--nt-tick-h', `${tickH}px`);

    this.headings.forEach((h, i) => {
      const tick = this.rail.createDiv({ cls: `nt-toc-tick nt-d-${Math.min(h.depth, 3)}` });
      tick.dataset.idx = String(i);

      const item = this.list.createDiv({ cls: 'nt-toc-item', text: h.text });
      item.dataset.idx = String(i);
      item.style.setProperty('--nt-depth', String(h.depth));
      item.setAttribute('role', 'button');
      item.setAttribute('title', h.text);
      if (h.depth === 0) item.classList.add('is-top');
    });
    this.paintActive();
  }

  currentLine() {
    try {
      const mode = this.view.currentMode;
      if (mode && typeof mode.getScroll === 'function') return Math.floor(mode.getScroll());
    } catch (e) {
      /* ignore */
    }
    return 0;
  }

  updateActive() {
    if (!this.headings.length) return;
    const line = this.currentLine();
    let idx = -1;
    for (let i = 0; i < this.headings.length; i++) {
      if (this.headings[i].line <= line + 1) idx = i;
      else break;
    }
    if (idx !== this.activeIdx) {
      this.activeIdx = idx;
      this.paintActive();
      if (this.open) this.scrollActiveIntoView();
    }
  }

  paintActive() {
    const mark = (container) => {
      container.querySelectorAll('.is-active').forEach((el) => el.classList.remove('is-active'));
      const el = container.children[this.activeIdx];
      if (el) el.classList.add('is-active');
    };
    mark(this.rail);
    mark(this.list);
  }

  scrollActiveIntoView() {
    const el = this.list.children[this.activeIdx];
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    const p = this.panel;
    if (top < p.scrollTop + 8) p.scrollTop = Math.max(0, top - 8);
    else if (bottom > p.scrollTop + p.clientHeight - 8) p.scrollTop = bottom - p.clientHeight + 8;
  }

  jump(h) {
    if (!h) return;
    this.activeIdx = this.headings.indexOf(h);
    this.paintActive();
    try {
      const mode = this.view.currentMode;
      if (this.view.getMode() === 'source' && this.view.editor) {
        this.view.editor.setCursor({ line: h.line, ch: 0 });
      }
      mode.applyScroll(h.line);
    } catch (e) {
      const file = this.view.file;
      if (file) this.view.leaf.openFile(file, { eState: { line: h.line } });
    }
  }

  destroy() {
    clearTimeout(this.closeTimer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.host.removeEventListener('scroll', this.onScroll, true);
    document.removeEventListener('pointerdown', this.onOutside, true);
    this.host.classList.remove('nt-toc-host');
    this.root.remove();
  }
}

module.exports = class NotionTocPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.controllers = new Map();

    this.addSettingTab(new NotionTocSettingTab(this.app, this));

    this.addCommand({
      id: 'toggle-toc',
      name: 'Toggle table of contents rail',
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        this.sync();
      },
    });

    const sync = () => this.sync();
    this.registerEvent(this.app.workspace.on('layout-change', sync));
    this.registerEvent(this.app.workspace.on('file-open', sync));
    this.registerEvent(this.app.workspace.on('active-leaf-change', sync));
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        for (const c of this.controllers.values()) {
          if (c.view.file && c.view.file.path === file.path) c.update();
        }
      })
    );
    this.app.workspace.onLayoutReady(sync);
  }

  sync() {
    const live = new Set();
    if (this.settings.enabled) {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) continue;
        live.add(view);
        let c = this.controllers.get(view);
        if (!c) {
          c = new TocController(this, view);
          this.controllers.set(view, c);
        } else {
          c.ensureAttached();
          c.update();
        }
      }
    }
    for (const [view, c] of this.controllers) {
      if (!live.has(view)) {
        c.destroy();
        this.controllers.delete(view);
      }
    }
  }

  refreshAll() {
    for (const c of this.controllers.values()) {
      c.applyStyle();
      c.signature = '';
      c.update();
    }
  }

  onunload() {
    for (const c of this.controllers.values()) c.destroy();
    this.controllers.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class NotionTocSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const save = async () => {
      await this.plugin.saveSettings();
      this.plugin.refreshAll();
    };

    new Setting(containerEl)
      .setName('Enable table of contents')
      .setDesc('Show the rail on every note.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.sync();
        })
      );

    new Setting(containerEl)
      .setName('Minimum headings')
      .setDesc('Hide the rail on notes with fewer headings than this.')
      .addSlider((s) =>
        s.setLimits(1, 10, 1).setValue(this.plugin.settings.minHeadings).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.minHeadings = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Deepest heading level')
      .setDesc('Headings deeper than this are left out (1 to 6).')
      .addSlider((s) =>
        s.setLimits(1, 6, 1).setValue(this.plugin.settings.maxLevel).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.maxLevel = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Sidebar width')
      .setDesc('Width of the hover sidebar in pixels.')
      .addSlider((s) =>
        s.setLimits(180, 420, 10).setValue(this.plugin.settings.panelWidth).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.panelWidth = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Distance from right edge')
      .setDesc('Move the rail left if it overlaps the scrollbar.')
      .addSlider((s) =>
        s.setLimits(0, 40, 1).setValue(this.plugin.settings.rightOffset).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.rightOffset = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Close delay')
      .setDesc('How long the sidebar stays open after the pointer leaves, in milliseconds.')
      .addSlider((s) =>
        s.setLimits(0, 1000, 50).setValue(this.plugin.settings.closeDelay).setDynamicTooltip().onChange(async (v) => {
          this.plugin.settings.closeDelay = v;
          await save();
        })
      );
  }
}
