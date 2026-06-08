import {
  Document, Packer, Paragraph, TextRun,
  Table, TableRow, TableCell,
  BorderStyle, WidthType, ShadingType,
} from 'docx'

// ── colour helpers ────────────────────────────────────────────────────────────
function severityColor(sev) {
  const s = (sev || '').toLowerCase()
  if (s === 'critical') return 'DC2626'
  if (s === 'major')    return 'D97706'
  if (s === 'minor')    return '16A34A'
  return '374151'
}

function statusColor(st) {
  const s = (st || '').toLowerCase()
  if (s === 'violated') return 'DC2626'
  if (s === 'partial')  return 'D97706'
  if (s === 'obeyed')   return '16A34A'
  return '374151'
}

function statusBg(st) {
  const s = (st || '').toLowerCase()
  if (s === 'violated') return 'FEF2F2'
  if (s === 'partial')  return 'FFFBEB'
  if (s === 'obeyed')   return 'F0FDF4'
  return 'FFFFFF'
}

function severityBg(sev) {
  const s = (sev || '').toLowerCase()
  if (s === 'critical') return 'FEF2F2'
  if (s === 'major')    return 'FFFBEB'
  if (s === 'minor')    return 'F0FDF4'
  return 'F3F4F6'
}

// ── heading paragraph ─────────────────────────────────────────────────────────
function heading(text, sizePt = 14, color = '374151', spaceBefore = 300) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: sizePt * 2, color })],
    spacing: { before: spaceBefore, after: 120 },
  })
}

// ── thin rule ─────────────────────────────────────────────────────────────────
function rule() {
  return new Paragraph({
    text: '',
    border: { bottom: { color: 'EDE9FE', style: BorderStyle.SINGLE, size: 6 } },
    spacing: { before: 0, after: 0 },
  })
}

// ── main export ───────────────────────────────────────────────────────────────
export async function exportEvaluationDocx(data, counts, checklistCounts) {
  const children = []

  // ── Document title ──────────────────────────────────────────────────────────
  children.push(
    new Paragraph({
      children: [new TextRun({ text: 'Evaluation Report', bold: true, size: 40, color: '6D28D9' })],
      spacing: { after: 80 },
    }),
    rule(),
  )

  // ── Summary ─────────────────────────────────────────────────────────────────
  if (data.summary) {
    children.push(
      heading('Summary', 13, '374151', 240),
      new Paragraph({
        children: [new TextRun({ text: data.summary, size: 22, color: '374151' })],
        spacing: { after: 160 },
      }),
    )
  }

  // ── Severity counts ──────────────────────────────────────────────────────────
  if (counts && (counts.critical > 0 || counts.major > 0 || counts.minor > 0)) {
    const runs = []
    if (counts.critical > 0) runs.push(new TextRun({ text: `${counts.critical} Critical   `, bold: true, color: 'DC2626', size: 22 }))
    if (counts.major > 0)    runs.push(new TextRun({ text: `${counts.major} Major   `, bold: true, color: 'D97706', size: 22 }))
    if (counts.minor > 0)    runs.push(new TextRun({ text: `${counts.minor} Minor`, bold: true, color: '16A34A', size: 22 }))
    children.push(new Paragraph({ children: runs, spacing: { after: 200 } }))
  }

  // ── Violations ───────────────────────────────────────────────────────────────
  if (data.violations?.length > 0) {
    children.push(heading('Violations', 13, '374151', 200))

    for (const [i, v] of data.violations.entries()) {
      const sevColor = severityColor(v.severity)
      const sevBg = severityBg(v.severity)

      // Header: number + rule + severity badge
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${i + 1}. `, bold: true, color: '6B7280', size: 22 }),
            new TextRun({ text: v.rule || '', bold: true, size: 22, color: '111827' }),
            new TextRun({ text: `   [${v.severity || ''}]`, bold: true, size: 20, color: sevColor }),
          ],
          spacing: { before: 240, after: 0 },
          shading: { fill: 'F3F4F6', type: ShadingType.SOLID },
          border: {
            left: { color: sevColor, style: BorderStyle.SINGLE, size: 12 },
            bottom: { color: 'D1D5DB', style: BorderStyle.SINGLE, size: 4 },
          },
          indent: { left: 160 },
        }),
      )

      // Instruction
      if (v.instruction) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: 'INSTRUCTION   ', bold: true, size: 18, color: '6B7280' }),
              new TextRun({ text: v.instruction, italics: true, size: 22, color: '374151' }),
            ],
            spacing: { before: 60, after: 60 },
            border: { bottom: { color: 'F3F4F6', style: BorderStyle.SINGLE, size: 4 } },
            indent: { left: 360 },
          }),
        )
      }

      // Evidence
      if (v.evidence) {
        if (Array.isArray(v.evidence)) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: 'EVIDENCE', bold: true, size: 18, color: '6B7280' })],
              spacing: { before: 60, after: 40 },
              indent: { left: 360 },
            }),
          )
          for (const e of v.evidence) {
            const eRuns = []
            if (e.timestamp) eRuns.push(new TextRun({ text: `${e.timestamp}  `, bold: true, size: 20, color: '7C3AED' }))
            if (e.quote)     eRuns.push(new TextRun({ text: `“${e.quote}”`, italics: true, size: 20, color: '374151' }))
            if (eRuns.length) {
              children.push(
                new Paragraph({
                  children: eRuns,
                  spacing: { before: 40, after: 40 },
                  indent: { left: 720 },
                  shading: { fill: 'F3F4F6', type: ShadingType.SOLID },
                }),
              )
            }
          }
        } else {
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: 'EVIDENCE   ', bold: true, size: 18, color: '6B7280' }),
                new TextRun({ text: String(v.evidence), size: 20, color: '374151' }),
              ],
              spacing: { before: 60, after: 60 },
              indent: { left: 360 },
            }),
          )
        }
      }

      children.push(new Paragraph({ text: '', spacing: { after: 80 } }))
    }
  }

  // ── Compliance Checklist ──────────────────────────────────────────────────────
  if (data.checklist?.length > 0) {
    children.push(heading('Compliance Checklist', 13, '374151', 320))

    // Score line
    if (checklistCounts) {
      const ccRuns = []
      if (checklistCounts.obeyed  > 0) ccRuns.push(new TextRun({ text: `${checklistCounts.obeyed} Obeyed   `,  bold: true, color: '16A34A', size: 22 }))
      if (checklistCounts.partial > 0) ccRuns.push(new TextRun({ text: `${checklistCounts.partial} Partial   `, bold: true, color: 'D97706', size: 22 }))
      if (checklistCounts.violated > 0) ccRuns.push(new TextRun({ text: `${checklistCounts.violated} Violated`, bold: true, color: 'DC2626', size: 22 }))
      if (ccRuns.length) children.push(new Paragraph({ children: ccRuns, spacing: { after: 160 } }))
    }

    // Table: Rule | Status | Evidence
    const COL = { rule: 4500, status: 1400, evidence: 4100 }
    const HEADER_BG = 'EDE9FE'

    const headerRow = new TableRow({
      tableHeader: true,
      children: [
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Rule', bold: true, size: 22, color: '374151' })] })],
          width: { size: COL.rule, type: WidthType.DXA },
          shading: { fill: HEADER_BG, type: ShadingType.SOLID },
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Status', bold: true, size: 22, color: '374151' })] })],
          width: { size: COL.status, type: WidthType.DXA },
          shading: { fill: HEADER_BG, type: ShadingType.SOLID },
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Evidence', bold: true, size: 22, color: '374151' })] })],
          width: { size: COL.evidence, type: WidthType.DXA },
          shading: { fill: HEADER_BG, type: ShadingType.SOLID },
        }),
      ],
    })

    const dataRows = data.checklist.map(r => {
      const bg = statusBg(r.status)
      const sc = statusColor(r.status)
      return new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: r.rule || '', size: 22, color: '111827' })] })],
            width: { size: COL.rule, type: WidthType.DXA },
            shading: { fill: bg, type: ShadingType.SOLID },
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: r.status || '', bold: true, size: 22, color: sc })] })],
            width: { size: COL.status, type: WidthType.DXA },
            shading: { fill: bg, type: ShadingType.SOLID },
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: r.evidence || '', size: 20, color: '6B7280' })] })],
            width: { size: COL.evidence, type: WidthType.DXA },
            shading: { fill: bg, type: ShadingType.SOLID },
          }),
        ],
      })
    })

    children.push(
      new Table({
        rows: [headerRow, ...dataRows],
        width: { size: COL.rule + COL.status + COL.evidence, type: WidthType.DXA },
      }),
    )
  }

  // ── Pack & download ──────────────────────────────────────────────────────────
  const doc = new Document({ sections: [{ children }] })
  const blob = await Packer.toBlob(doc)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'evaluation-report.docx'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
