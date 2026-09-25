#!/usr/bin/env python3
"""Generate production/owner-mbp-workbook-layout.js from the owner's MBP workbook.

The workbook itself is private and stays outside this repository. Only presentation
is read here: column widths, row heights, merges, hidden rows/columns, outline
(group) levels, freeze panes, cell fills/fonts/borders/alignment and number-format
strings, plus the workbook's own static header labels. Every numeric value and
every formula is dropped, and Budget - 2 / Income Statement - 2 contribute geometry
only, because those two sheets carry their own styles and account names inside the
private finance document.

    python3 scripts/mbp-workbook-layout.py "<path to MBP 2026 .xlsx>"

Requires openpyxl (pip install openpyxl) in a local virtualenv; it is a build-time
tool, not a runtime dependency of the dashboard.
"""
import json, re, sys
from datetime import date
import openpyxl

# id -> (worksheet name, kind). Sheet ids are the workbook tab order Dylan sees.
SHEETS = [
    ('sales_total', 'Sales Plan - (Wk) TOTAL', 'sales'),
    ('sales_painting', 'SP - (Wk) Painting', 'sales'),
    ('sales_epoxy', 'SP - (Wk) Epoxy', 'sales'),
    ('revenue_total', 'Revenue Produced - (Wk) TOTAL', 'revenue'),
    ('revenue_painting', 'RP - (Wk) Painting', 'revenue'),
    ('revenue_epoxy', 'RP - (Wk) Epoxy', 'revenue'),
    ('budget', 'Budget - 2', 'budget'),
    ('income', 'Income Statement - 2', 'income'),
]
# Budget - 2 and Income Statement - 2 keep their account names and values in the
# private finance document, so only their presentation is generated here.
NO_LABELS = {'budget', 'income'}
# Flag column -> (cumulative actual column, cumulative plan column). Workbook rule:
# Grey when the week is still in the future or rounded actual >= rounded plan, else Red.
FLAG_PAIRS = {
    'sales': {'G': ('F', 'E'), 'M': ('L', 'K'), 'S': ('R', 'Q'), 'Y': ('X', 'W'),
              'AF': ('AD', 'AC'), 'AS': ('AR', 'AP')},
    'revenue': {'H': ('F', 'E'), 'N': ('M', 'L'), 'U': ('T', 'R')},
}
# Google Sheets theme from xl/theme/theme1.xml: dk1 = dk2 = 434343, lt1 = lt2 = FFFFFF.
THEME = {0: 'FFFFFF', 1: '434343', 2: 'FFFFFF', 3: '434343'}


def col_letter(n):
    s = ''
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def hexcolor(color):
    if color is None:
        return None
    if color.type == 'rgb' and color.rgb and color.rgb != '00000000':
        return '#' + color.rgb[-6:]
    if color.type == 'theme':
        base = THEME.get(color.theme)
        if not base:
            return None
        rgb = [int(base[i:i + 2], 16) for i in (0, 2, 4)]
        tint = color.tint or 0
        if tint > 0:
            rgb = [round(v + (255 - v) * tint) for v in rgb]
        elif tint < 0:
            rgb = [round(v * (1 + tint)) for v in rgb]
        return '#%02X%02X%02X' % tuple(rgb)
    return None


def side(border_side):
    if not border_side or not border_side.style:
        return None
    return f'{border_side.style} {hexcolor(border_side.color) or "#000000"}'


def style_of(cell):
    style = {}
    fill = cell.fill
    if fill and fill.patternType == 'solid':
        bg = hexcolor(fill.fgColor)
        if bg:
            style['bg'] = bg
    font = cell.font
    if font:
        fg = hexcolor(font.color)
        if fg:
            style['fg'] = fg
        if font.bold:
            style['bold'] = 1
        if font.italic:
            style['italic'] = 1
        if font.underline:
            style['underline'] = 1
        if font.sz and float(font.sz) != 10.0:
            style['size'] = float(font.sz)
        if font.name and font.name != 'Roboto':
            style['face'] = font.name
    for name, key in (('top', 'bt'), ('right', 'brt'), ('bottom', 'bb'), ('left', 'bl')):
        value = side(getattr(cell.border, name, None))
        if value:
            style[key] = value
    if cell.number_format and cell.number_format != 'General':
        style['nf'] = cell.number_format
    align = cell.alignment
    if align:
        if align.horizontal:
            style['h'] = align.horizontal
        if align.vertical:
            style['v'] = align.vertical
        if align.wrap_text:
            style['wrap'] = 1
        if align.indent:
            style['indent'] = align.indent
    return style


def dimension_map(dimensions, attribute, skip=None):
    """Explode openpyxl's min..max dimension groups into one entry per index."""
    out = {}
    for dim in dimensions.values():
        value = getattr(dim, attribute)
        if value is None or (skip is not None and value == skip):
            continue
        for index in range(dim.min, dim.max + 1):
            out[index] = value
    return out


def flags(dimensions, attribute):
    out = []
    for dim in dimensions.values():
        if getattr(dim, attribute):
            out.extend(range(dim.min, dim.max + 1))
    return sorted(set(out))


def row_dimension_map(rows, attribute, skip=None):
    out = {}
    for key, dim in rows.items():
        value = getattr(dim, attribute)
        if value is None or (skip is not None and value == skip):
            continue
        out[int(key)] = value
    return out


def outline_groups(levels, hidden, last):
    """Contiguous runs at level >= 1. summaryBelow is False in this workbook, so the
    control lives on the nearest lower-level row above the run."""
    groups, start = [], None
    for row in range(1, last + 1):
        level = levels.get(row, 0)
        if level >= 1 and start is None:
            start = row
        elif level == 0 and start is not None:
            groups.append((start, row - 1))
            start = None
    if start is not None:
        groups.append((start, last))
    return [{'from': a, 'to': b, 'summary': a - 1 if a > 1 else None,
             'collapsed': all(hidden.get(r, False) for r in range(a, b + 1))}
            for a, b in groups]


def sheet_spec(worksheet, sheet_id, kind):
    last_row, last_col = worksheet.max_row, worksheet.max_column
    freeze = None
    if worksheet.freeze_panes:
        match = re.match(r'^([A-Z]+)(\d+)$', worksheet.freeze_panes)
        letters, row = match.group(1), int(match.group(2))
        freeze = {'row': row - 1,
                  'col': sum((ord(c) - 64) * 26 ** i for i, c in enumerate(reversed(letters))) - 1}
    row_hidden = {int(key): bool(dim.hidden) for key, dim in worksheet.row_dimensions.items()}
    row_levels = row_dimension_map(worksheet.row_dimensions, 'outlineLevel', skip=0)
    col_levels = dimension_map(worksheet.column_dimensions, 'outlineLevel', skip=0)
    spec = {
        'tab': worksheet.title,
        'kind': kind,
        'rows': last_row,
        'cols': last_col,
        'defaultColWidth': worksheet.sheet_format.defaultColWidth or 12.1,
        'defaultRowHeight': worksheet.sheet_format.defaultRowHeight or 15.0,
        'freeze': freeze,
        'colWidths': {str(k): round(v, 2) for k, v in dimension_map(worksheet.column_dimensions, 'width').items()},
        'hiddenCols': flags(worksheet.column_dimensions, 'hidden'),
        'colOutline': {str(k): v for k, v in col_levels.items()},
        'rowHeights': {str(k): round(float(v), 2) for k, v in row_dimension_map(worksheet.row_dimensions, 'height').items()},
        'hiddenRows': sorted(r for r, h in row_hidden.items() if h),
        'rowOutline': {str(k): v for k, v in row_levels.items()},
        'rowGroups': outline_groups(row_levels, row_hidden, last_row),
        'merges': sorted(str(m) for m in worksheet.merged_cells.ranges),
    }
    grid = None
    if kind in FLAG_PAIRS:
        # The 52 week rows start one row below the frozen header; the bottom totals row
        # sits two rows below the last week, with one blank spacer row between them.
        data_from = freeze['row'] + 1
        footer_row = data_from + 53
        grid = {
            'dataFrom': data_from, 'dataTo': data_from + 51, 'footerRow': footer_row,
            'quarterCol': 1, 'dateCol': 2, 'flags': FLAG_PAIRS[kind],
            # Only the columns the workbook actually totals; the rest of the row is blank.
            'footerCells': sorted(col_letter(c) for c in range(1, last_col + 1)
                                  if worksheet.cell(row=footer_row, column=c).value is not None),
        }
        spec['grid'] = grid
    styles, style_index, templates, template_index, template_of, labels = [], {}, [], {}, {}, {}
    for row in range(1, last_row + 1):
        template = []
        for col in range(1, last_col + 1):
            cell = worksheet.cell(row=row, column=col)
            style = style_of(cell)
            if not style:
                template.append(0)
                continue
            key = json.dumps(style, sort_keys=True)
            if key not in style_index:
                styles.append(style)
                style_index[key] = len(styles)
            template.append(style_index[key])
            value = cell.value
            # Static header text only. Week rows carry engine values (including the
            # quarter label and the Red/Grey flag text) and the finance sheets keep
            # their account names in the private document, so neither adds labels.
            if (isinstance(value, str) and not value.startswith('=')
                    and sheet_id not in NO_LABELS
                    and not (grid and grid['dataFrom'] <= row <= grid['dataTo'])):
                labels[col_letter(col) + str(row)] = value
        key = json.dumps(template)
        if key not in template_index:
            templates.append(template)
            template_index[key] = len(templates) - 1
        template_of[str(row)] = template_index[key]
    spec.update({'templates': templates, 'rowTemplate': template_of, 'labels': labels})
    return spec, styles


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        raise SystemExit('Pass the path to the private MBP workbook (.xlsx).')
    book = openpyxl.load_workbook(path, data_only=False)
    out, shared, shared_index = {}, [], {}
    for sheet_id, name, kind in SHEETS:
        spec, styles = sheet_spec(book[name], sheet_id, kind)
        if styles:
            remap = {}
            for i, style in enumerate(styles, start=1):
                key = json.dumps(style, sort_keys=True)
                if key not in shared_index:
                    shared.append(style)
                    shared_index[key] = len(shared)
                remap[i] = shared_index[key]
            spec['templates'] = [[remap.get(v, 0) for v in row] for row in spec['templates']]
        out[sheet_id] = spec
    document = {'version': 1, 'generated': date.today().isoformat(), 'styles': shared, 'sheets': out}
    body = json.dumps(document, separators=(',', ':'), sort_keys=True)
    header = (
        '// Generated by scripts/mbp-workbook-layout.py from the owner\'s private MBP workbook.\n'
        '// Presentation only: geometry, fills, fonts, borders, number-format strings and the\n'
        '// workbook\'s own static header labels. No values, formulas, account names or owner\n'
        '// financial data are in this file. Regenerate with the script; do not hand-edit.\n'
    )
    target = 'production/owner-mbp-workbook-layout.js'
    with open(target, 'w') as handle:
        handle.write(header + 'export const MBP_WORKBOOK_LAYOUT = ' + body + ';\n')
    print(f'wrote {target}: {len(shared)} styles, {len(out)} sheets')
    for sheet_id, spec in out.items():
        print(f"  {sheet_id:16s} {spec['rows']}x{spec['cols']} templates="
              f"{len(spec.get('templates', []))} labels={len(spec.get('labels', {}))} "
              f"merges={len(spec['merges'])} hiddenCols={len(spec['hiddenCols'])} "
              f"hiddenRows={len(spec['hiddenRows'])} groups={len(spec['rowGroups'])}")


if __name__ == '__main__':
    main()
