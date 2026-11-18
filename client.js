window.__ModuleLoader__.load({
  id: '@local/bandizip',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const PACKAGE = '@local/bandizip';
    const ROW_ID = 'bandizip';
    const SLOT_KEY = `${PACKAGE}#${ROW_ID}`;

    const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      field: 'var(--dsw-alias-bg-layer-2)',
    };

    const CARD = { border: `1px solid ${C.border}`, borderRadius: 12, padding: '18px 20px', marginBottom: 14 };
    const CARD_TITLE = { fontSize: 15, fontWeight: 600, margin: '0 0 6px', color: C.text };
    const CARD_DESC = { fontSize: 13, lineHeight: 1.55, color: C.dim, margin: '0 0 14px' };
    const ROWS = { background: C.field, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' };
    const ROW = { padding: '14px 16px' };
    const ROW_TITLE = { fontSize: 13.5, fontWeight: 600, color: C.text, margin: 0 };
    const ROW_DESC = { fontSize: 12.5, lineHeight: 1.5, color: C.dim, margin: '4px 0 0' };
    const FIELD = {
      width: '100%', boxSizing: 'border-box', padding: '8px 10px',
      fontSize: 13, lineHeight: 1.4, color: C.text, background: 'var(--dsw-alias-bg-base, transparent)',
      border: `1px solid ${C.border}`, borderRadius: 8, outline: 'none',
      fontFamily: 'inherit', transition: `border-color 140ms ${EASE_OUT}`,
    };
    const press = (extra) => ({
      ...extra,
      onPointerDown: (event) => { event.currentTarget.style.transform = 'scale(0.97)'; },
      onPointerUp: (event) => { event.currentTarget.style.transform = 'scale(1)'; },
      onPointerLeave: (event) => { event.currentTarget.style.transform = 'scale(1)'; },
    });

    function Switch(props) {
      const on = props.value === true;
      return h('label', {
        style: { position: 'relative', display: 'inline-flex', flexShrink: 0, cursor: 'pointer', paddingTop: 2 },
      }, [
        h('span', {
          key: 'track', 'aria-hidden': true,
          style: {
            position: 'relative', width: 44, height: 24, borderRadius: 999,
            background: on ? C.text : C.border,
            transition: `background-color 160ms ${EASE_OUT}`,
          },
        }, [
          h('span', {
            key: 'knob',
            style: {
              position: 'absolute', top: 3, left: on ? 23 : 3, width: 18, height: 18,
              borderRadius: '50%',
              background: on ? 'var(--dsw-alias-bg-base, #111)' : 'var(--dsw-alias-label-secondary)',
              transition: `left 160ms ${EASE_OUT}, background-color 160ms ${EASE_OUT}`,
            },
          }),
        ]),
        h('input', {
          key: 'cb', type: 'checkbox', checked: on,
          onChange: (event) => props.onChange(event.target.checked),
          style: { position: 'absolute', opacity: 0, width: 0, height: 0 },
        }),
      ]);
    }

    function ChoiceRow(props) {
      const active = props.active;
      return h('label', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 12, padding: '13px 16px',
          borderTop: props.first ? 'none' : `1px solid ${C.border}`,
          cursor: 'pointer',
          background: active ? 'color-mix(in srgb, ' + C.brand + ' 10%, transparent)' : 'transparent',
          transition: `background-color 140ms ${EASE_OUT}`,
        },
      }, [
        h('span', {
          key: 'dot', 'aria-hidden': true,
          style: {
            flexShrink: 0, marginTop: 2, width: 16, height: 16, borderRadius: '50%',
            border: `1.5px solid ${active ? C.brand : C.border}`,
            display: 'grid', placeItems: 'center',
          },
        }, active ? h('span', {
          key: 'i', style: { width: 8, height: 8, borderRadius: '50%', background: C.brand },
        }) : null),
        h('input', {
          key: 'r', type: 'radio', name: props.name, checked: active,
          onChange: props.onSelect, style: { position: 'absolute', opacity: 0, width: 0, height: 0 },
        }),
        h('div', { key: 'copy', style: { minWidth: 0 } }, [
          h('p', { key: 't', style: ROW_TITLE }, props.label),
          h('p', { key: 'd', style: ROW_DESC }, props.hint),
        ]),
      ]);
    }

    const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);

    function Page(props) {
      const form = props.ownerForm;
      const view = props.view ?? 'page';
      const [draft, setDraft] = useState(null);
      const [baseline, setBaseline] = useState(null);
      const [status, setStatus] = useState({ kind: 'idle', error: null });
      const [snapshotState, setSnapshotState] = useState({ status: 'loading', writable: false });
      const revision = useRef(undefined);
      /** The last Host-confirmed values, readable from inside the subscription. */
      const baselineRef = useRef(null);

      useEffect(() => {
        if (!form) return undefined;
        baselineRef.current = null;
        const read = () => {
          try {
            const snapshot = form.getSnapshot();
            revision.current = snapshot.revision;
            setSnapshotState({
              status: snapshot.status,
              writable: snapshot.writable === true,
            });
            const next = snapshot.value ?? {};
            const previousBaseline = baselineRef.current;
            baselineRef.current = next;
            setBaseline(next);
            // An external change (another window, a reconnect) must not silently discard
            // what the user is typing: adopt the Host value only when nothing is pending.
            setDraft((previous) => (
              previous === null
                || previousBaseline === null
                || JSON.stringify(previous) === JSON.stringify(previousBaseline)
                ? next
                : previous
            ));
          } catch (error) {
            setStatus({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
          }
        };
        read();
        if (typeof form.subscribe === 'function') return form.subscribe(read);
        return undefined;
      }, [form]);

      if (!form || draft === null) {
        return h('p', { style: { fontSize: 13, color: C.dim, margin: '12px 0' } },
          status.kind === 'error' ? `读取配置失败：${status.error}` : '读取配置中…');
      }

      // A namespace the Host does not serve has no values to edit: rendering the schema
      // defaults here would show settings that are not the plugin's real configuration.
      if (snapshotState.status === 'unavailable') {
        return h('p', { style: { fontSize: 13, color: C.dim, margin: '12px 0' } },
          '此插件当前没有可配置项（Host 未提供 bandizip 配置节）。');
      }
      // Until the first accepted section arrives, `draft` is `{}` — printing it would
      // present the schema defaults as if they were the plugin's saved settings.
      if (snapshotState.status !== 'ready') {
        return h('p', { style: { fontSize: 13, color: C.dim, margin: '12px 0' } }, '读取配置中…');
      }

      const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
      // `writable` is false while the Host document refuses writes; a disabled save button
      // is honest about that instead of failing after the click.
      const canWrite = snapshotState.writable;
      const update = (patch) => setDraft({ ...draft, ...patch });
      // An emptied number input yields '' → `Number('')` is 0, which the schema rejects
      // (timeoutSeconds) or the Host silently reverts. Keep the previous value instead of
      // writing a meaningless 0 into the draft.
      const updateNumber = (field, raw) => {
        const trimmed = typeof raw === 'string' ? raw.trim() : String(raw);
        if (trimmed === '') return;
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) return;
        update({ [field]: parsed });
      };
      const bzPath = typeof draft.bzPath === 'string' ? draft.bzPath : '';

      if (view === 'summary') {
        return h('span', { style: { fontSize: 12.5, color: C.dim } },
          bzPath === '' ? 'bz.exe 自动探测' : bzPath);
      }

      const commit = (value) => {
        setStatus({ kind: 'saving', error: null });
        const settle = (error) => setStatus(error === undefined
          ? { kind: 'saved', error: null }
          : { kind: 'error', error: error instanceof Error ? error.message : String(error) });
        try {
          // `mutate` resolves `true` only on Host acceptance; `false` means refused or
          // skipped (stale revision, schema rejection), and transport failures reject.
          const result = form.mutate([{ op: 'set', path: [], value }], revision.current);
          if (result && typeof result.then === 'function') {
            result.then(
              (accepted) => {
                if (accepted === true) settle(undefined);
                else settle(new Error('保存被拒绝：配置可能已被其他窗口修改，或取值不符合校验规则。'));
              },
              (error) => settle(error),
            );
          } else {
            // A non-promise answer is not the documented contract; do not claim success.
            settle(new Error('保存未生效：配置写法返回了非 Promise 结果。'));
          }
        } catch (error) {
          settle(error);
        }
      };

      const textField = (label, hint, value, onChange, props2 = {}) => h('div', {
        style: { ...ROW, borderTop: props2.first ? 'none' : `1px solid ${C.border}` },
      }, [
        h('p', { key: 'l', style: { ...ROW_TITLE, marginBottom: 8 } }, label),
        h('input', {
          key: 'i', ...FIELD, value, onChange: (event) => onChange(event.target.value),
          onFocus: (event) => { event.currentTarget.style.borderColor = C.brand; },
          onBlur: (event) => { event.currentTarget.style.borderColor = C.border; },
          ...props2.input,
        }),
        hint ? h('p', { key: 'h', style: { ...ROW_DESC, marginTop: 8 } }, hint) : null,
      ]);

      /** One label + hint + switch row, the shape every boolean setting uses. */
      const switchField = (key, label, hint, value, onChange, first) => h('div', {
        key,
        style: {
          ...ROW, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18,
          ...(first ? {} : { borderTop: `1px solid ${C.border}` }),
        },
      }, [
        h('div', { key: 'c', style: { minWidth: 0 } }, [
          h('p', { key: 't', style: ROW_TITLE }, label),
          h('p', { key: 'd', style: ROW_DESC }, hint),
        ]),
        h(Switch, { key: 's', value, onChange }),
      ]);

      /** One label + hint + radio group, for a small enum setting. */
      const choiceField = (key, label, hint, options, current, onSelect, first) => h('div', {
        key,
        style: { ...ROW, ...(first ? {} : { borderTop: `1px solid ${C.border}` }) },
      }, [
        h('p', { key: 'l', style: { ...ROW_TITLE, marginBottom: 8 } }, label),
        h('div', { key: 'opts', style: { border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' } },
          options.map(([value, optionLabel, optionHint], index) => h(ChoiceRow, {
            key: value,
            first: index === 0,
            name: `bandizip-${key}`,
            label: optionLabel,
            hint: optionHint,
            active: current === value,
            onSelect: () => onSelect(value),
          }))),
        hint ? h('p', { key: 'h', style: { ...ROW_DESC, marginTop: 8 } }, hint) : null,
      ]);

      return h('div', { style: { fontSize: 13, color: C.text, maxWidth: 760 } }, [
        // 总开关前置：先决定要不要用这个工具，再谈细节。
        h('section', { key: 'master', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '总开关'),
          h('p', { key: 'd', style: CARD_DESC }, '关闭后 bandizip 工具即被移除，下面的设置保留不生效。'),
          h('div', { key: 'box', style: ROWS }, h('div', {
            style: { ...ROW, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18 },
          }, [
            h('div', { key: 'c', style: { minWidth: 0 } }, [
              h('p', { key: 't', style: ROW_TITLE }, '启用 Bandizip 工具'),
              h('p', { key: 'd', style: ROW_DESC }, '让智能体可以压缩、解压、查看和校验压缩包。'),
            ]),
            h(Switch, {
              key: 's',
              value: draft.enabled !== false,
              onChange: (value) => update({ enabled: value }),
            }),
          ])),
        ]),

        h('section', { key: 'exe', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '执行器'),
          h('p', { key: 'd', style: CARD_DESC }, 'bz.exe 的位置与调用限制。留空时依次尝试标准安装目录，最后交给 PATH。'),
          h('div', { key: 'box', style: ROWS }, [
            textField('bz.exe 路径', '也可以设置环境变量 BANDIZIP_BZ 来覆盖。', bzPath,
              (value) => update({ bzPath: value }), { first: true, input: { placeholder: 'C:\\Program Files\\Bandizip\\bz.exe' } }),
            textField('超时（秒）', '单次调用超过这个时间会终止进程并报告超时（1-86400）。', num(draft.timeoutSeconds, 900),
              (value) => updateNumber('timeoutSeconds', value), { input: { type: 'number', min: 1, max: 86400, step: 60 } }),
            textField('输出上限（字符）', '回传给模型的最长输出，超出部分会被截断（500-200000）。', num(draft.maxOutputChars, 12000),
              (value) => updateNumber('maxOutputChars', value), { input: { type: 'number', min: 500, max: 200000, step: 500 } }),
          ]),
        ]),

        h('section', { key: 'extract', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '解压默认值'),
          h('p', { key: 'd', style: CARD_DESC }, '调用时未显式指定这些参数，就按这里的取值执行。'),
          h('div', { key: 'box', style: ROWS }, [
            choiceField('overwrite', '同名文件处理',
              '解压时目标目录已有同名文件怎么办。覆盖最省事但会丢掉原有内容。',
              [
                ['overwrite', '覆盖', '已存在的文件直接替换。'],
                ['skip', '跳过', '保留已有文件，只解出新文件。'],
                ['rename', '保留两者', '重名文件自动加序号。'],
              ],
              draft.defaultOverwrite ?? 'overwrite',
              (value) => update({ defaultOverwrite: value }), true),
            switchField('flat', '默认丢弃目录结构',
              '解压时只保留文件、不重建子目录。适合扁平压缩包；嵌套目录的包打开后文件会挤在一起。',
              draft.defaultFlat === true,
              (value) => update({ defaultFlat: value })),
            choiceField('destination', '默认解压位置',
              '未指定 destination 时解到哪里。cwd 会让不同压缩包解出的同名文件互相覆盖。',
              [
                ['beside', '压缩包旁边', '解到压缩包旁的同名文件夹，原包位置不变。'],
                ['cwd', '会话工作目录', '解到当前会话的工作目录，便于后续直接引用。'],
              ],
              draft.defaultDestination ?? 'beside',
              (value) => update({ defaultDestination: value })),
            switchField('verify', '打包后自动校验',
              '创建成功后自动再跑一次完整性校验。更可靠，但每个压缩包多花一次往返时间。',
              draft.verifyAfterCreate === true,
              (value) => update({ verifyAfterCreate: value })),
          ]),
        ]),

        h('section', { key: 'pack', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '打包默认值'),
          h('p', { key: 'd', style: CARD_DESC }, 'create 未显式指定这些参数时的取值。'),
          h('div', { key: 'box', style: ROWS }, [
            textField('压缩级别', '0 只打包不压缩、速度最快；9 体积最小但明显更慢。默认按这里的取值。', num(draft.defaultLevel, 5),
              (value) => updateNumber('defaultLevel', value),
              { first: true, input: { type: 'number', min: 0, max: 9, step: 1 } }),
            switchField('archiveOverwrite', '允许覆盖同名压缩包',
              '关闭时，即使调用方显式传 overwrite:"overwrite" 也会拒绝覆盖已有压缩包——这是防止误删旧包的总开关。',
              draft.allowArchiveOverwrite === true,
              (value) => update({ allowArchiveOverwrite: value })),
            switchField('recursive', '默认递归子目录',
              '关闭后只打包每层文件，目录结构不再深入，嵌套内容会被漏掉。',
              draft.defaultRecursive !== false,
              (value) => update({ defaultRecursive: value })),
            choiceField('fallback', '无法识别扩展名时的格式',
              '压缩包名没有可识别扩展名时用哪种格式。auto 表示直接报错，让调用方显式指定格式。',
              [
                ['auto', '自动（报错）', '不猜格式，直接要求调用方传 format。'],
                ['zip', 'zip', '兼容性最好，体积一般。'],
                ['7z', '7z', '压缩率更高，需要对方能解 7z。'],
                ['tar', 'tar', '不压缩的归档，适合打包目录结构。'],
                ['tgz', 'tgz', 'tar.gz，Linux 下常见。'],
                ['gz', 'gz', '只压缩单个文件，不含目录结构。'],
                ['xz', 'xz', '压缩率高但较慢。'],
              ],
              draft.fallbackFormat ?? 'auto',
              (value) => update({ fallbackFormat: value })),
          ]),
        ]),

        h('section', { key: 'safety', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '安全'),
          h('p', { key: 'd', style: CARD_DESC }, '限制这个工具能做什么。默认都取较宽松的一侧。'),
          h('div', { key: 'box', style: ROWS }, [
            switchField('password', '允许使用密码',
              '关闭后任何带 password 的调用都会失败。开启时密码以命令行参数传给 bz.exe，本机其它进程可能看到。',
              draft.allowPassword !== false,
              (value) => update({ allowPassword: value }), true),
            switchField('restrict', '限制在工作区内',
              '拒绝工作区之外的 archive / files / destination。注意：开启后会挡掉工作区外的合法跨盘操作，只在需要强边界时启用。',
              draft.restrictToWorkspace === true,
              (value) => update({ restrictToWorkspace: value })),
          ]),
        ]),

        h('div', { key: 'footer', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 } }, [
          h('button', {
            key: 'save', type: 'button',
            ...press({
              disabled: !dirty || !canWrite || status.kind === 'saving',
              onClick: () => commit({ ...draft, bzPath: bzPath.trim() }),
              style: {
                padding: '8px 18px', fontSize: 13, fontWeight: 500, lineHeight: 1.2,
                borderRadius: 8, border: '1px solid transparent',
                background: C.text, color: 'var(--dsw-alias-bg-base, #111)',
                cursor: dirty && canWrite ? 'pointer' : 'default', opacity: dirty && canWrite ? 1 : 0.45,
                transition: `transform 140ms ${EASE_OUT}, opacity 140ms ${EASE_OUT}`, fontFamily: 'inherit',
              },
            }),
          }, status.kind === 'saving' ? '保存中…' : '保存'),

          h('button', {
            key: 'reset', type: 'button',
            ...press({
              disabled: !dirty,
              onClick: () => { setDraft(baseline); setStatus({ kind: 'idle', error: null }); },
              style: {
                padding: '8px 14px', fontSize: 13, lineHeight: 1.2, borderRadius: 8,
                border: '1px solid transparent', background: 'transparent',
                color: C.dim, cursor: dirty ? 'pointer' : 'default', opacity: dirty ? 1 : 0.5,
                transition: `transform 140ms ${EASE_OUT}`, fontFamily: 'inherit',
              },
            }),
          }, '重置'),
          h('span', {
            key: 'status', role: 'status',
            style: {
              marginLeft: 'auto', fontSize: 12.5,
              color: status.kind === 'error' ? C.error : C.dim,
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, status.kind === 'error' ? (status.error ?? '保存失败') : status.kind === 'saved' ? '已保存' : ''),
        ]),
      ]);
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        // The settings namespace is the Loader entry's `options.id` — the row id from
        // cordis.patch.yml — NOT the entry's dotted id (`include:bandizip`). `get()` always
        // returns a controller, so probing candidate ids cannot detect a wrong one; the
        // snapshot's `status` is what reports "unavailable".
        let ownerForm;
        try {
          ownerForm = ctx.configForms?.get?.(ROW_ID);
        } catch {
          ownerForm = undefined;
        }

        return ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: SLOT_KEY,
          locale: PACKAGE,
        }, (props) => h(Page, { ...props, ownerForm })));
      },
    };
  },
});
