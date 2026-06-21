package handlers

import (
	"bytes"
	"strconv"
	"strings"

	"github.com/go-pdf/fpdf"
)

// renderInvoicePDF turns the computed invoice into a downloadable PDF using the
// pure-Go fpdf library (core Helvetica fonts, A4 portrait). When paid is true a
// green "PAID" stamp and banner are drawn.
func renderInvoicePDF(d *invoiceData, paid bool) ([]byte, error) {
	const (
		marginL = 18.0
		marginR = 18.0
		pageW   = 210.0
		contentW = pageW - marginL - marginR
	)

	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(marginL, 16, marginR)
	pdf.SetAutoPageBreak(true, 18)
	pdf.AddPage()

	// ── header: title + brand ────────────────────────────────────────────────
	pdf.SetFont("Helvetica", "B", 22)
	pdf.SetTextColor(17, 24, 39) // gray-900
	pdf.CellFormat(0, 10, "Timesheet Invoice", "", 0, "L", false, 0, "")

	// brand block on the right
	pdf.SetFont("Helvetica", "B", 13)
	pdf.SetTextColor(79, 70, 229) // brand/indigo
	pdf.CellFormat(0, 10, "TimeTracker", "", 1, "R", false, 0, "")

	// period subtitle
	pdf.SetFont("Helvetica", "", 10)
	pdf.SetTextColor(107, 114, 128) // gray-500
	pdf.CellFormat(0, 6, "Period: "+fmtPDFDate(d.From)+"  -  "+fmtPDFDate(d.To), "", 1, "L", false, 0, "")

	pdf.Ln(2)
	drawRule(pdf, marginL, marginR)
	pdf.Ln(4)

	// ── PAID banner ──────────────────────────────────────────────────────────
	if paid {
		y := pdf.GetY()
		pdf.SetFillColor(220, 252, 231) // green-100
		pdf.SetDrawColor(187, 247, 208) // green-200
		pdf.Rect(marginL, y, contentW, 12, "FD")
		pdf.SetXY(marginL+4, y+2)
		pdf.SetFont("Helvetica", "B", 11)
		pdf.SetTextColor(21, 128, 61) // green-700
		pdf.CellFormat(0, 4, "PAID", "", 1, "L", false, 0, "")
		pdf.SetX(marginL + 4)
		pdf.SetFont("Helvetica", "", 8)
		pdf.SetTextColor(22, 163, 74)
		pdf.CellFormat(0, 4, "Timesheet approved. This invoice is locked - no further edits can be made.", "", 1, "L", false, 0, "")
		pdf.SetY(y + 12)
		pdf.Ln(5)
	}

	// ── bill-to (employee) ───────────────────────────────────────────────────
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetTextColor(156, 163, 175) // gray-400
	pdf.CellFormat(0, 4, "EMPLOYEE", "", 1, "L", false, 0, "")
	name := d.FullName
	if strings.TrimSpace(name) == "" {
		name = d.Email
	}
	pdf.SetFont("Helvetica", "B", 12)
	pdf.SetTextColor(17, 24, 39)
	pdf.CellFormat(0, 6, name, "", 1, "L", false, 0, "")
	if strings.TrimSpace(d.FullName) != "" {
		pdf.SetFont("Helvetica", "", 9)
		pdf.SetTextColor(107, 114, 128)
		pdf.CellFormat(0, 5, d.Email, "", 1, "L", false, 0, "")
	}
	pdf.Ln(5)

	// ── line-items table ─────────────────────────────────────────────────────
	// Columns: Project | Hours | Rate/hr | Amount
	wProject := contentW * 0.40
	wHours := contentW * 0.16
	wRate := contentW * 0.22
	wAmount := contentW * 0.22

	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetFillColor(243, 244, 246) // gray-100
	pdf.SetTextColor(107, 114, 128)
	pdf.CellFormat(wProject, 8, "PROJECT", "", 0, "L", true, 0, "")
	pdf.CellFormat(wHours, 8, "HOURS", "", 0, "R", true, 0, "")
	pdf.CellFormat(wRate, 8, "RATE / HR", "", 0, "R", true, 0, "")
	pdf.CellFormat(wAmount, 8, "AMOUNT", "", 1, "R", true, 0, "")

	pdf.SetFont("Helvetica", "", 10)
	pdf.SetTextColor(31, 41, 55) // gray-800
	if len(d.Lines) == 0 {
		pdf.SetTextColor(156, 163, 175)
		pdf.CellFormat(contentW, 12, "No tracked time in this period.", "B", 1, "C", false, 0, "")
	} else {
		for _, l := range d.Lines {
			rate := "-"
			if l.RateCents > 0 {
				rate = fmtPDFMoney(int64(l.RateCents), d.Currency)
			}
			pdf.SetTextColor(31, 41, 55)
			pdf.CellFormat(wProject, 8, truncate(l.Name, 40), "B", 0, "L", false, 0, "")
			pdf.CellFormat(wHours, 8, fmtPDFHours(l.Seconds), "B", 0, "R", false, 0, "")
			pdf.CellFormat(wRate, 8, rate, "B", 0, "R", false, 0, "")
			pdf.CellFormat(wAmount, 8, fmtPDFMoney(l.AmountCents, d.Currency), "B", 1, "R", false, 0, "")
		}
	}

	pdf.Ln(4)

	// ── totals box (right-aligned) ───────────────────────────────────────────
	boxW := wRate + wAmount
	boxX := marginL + contentW - boxW
	labelW := boxW * 0.55
	valueW := boxW * 0.45

	pdf.SetX(boxX)
	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(107, 114, 128)
	pdf.CellFormat(labelW, 7, "Total hours", "", 0, "L", false, 0, "")
	pdf.SetTextColor(31, 41, 55)
	pdf.CellFormat(valueW, 7, fmtPDFHours(d.TotalSeconds), "", 1, "R", false, 0, "")

	pdf.SetX(boxX)
	pdf.SetLineWidth(0.3)
	pdf.SetDrawColor(209, 213, 219)
	pdf.Line(boxX, pdf.GetY(), boxX+boxW, pdf.GetY())
	pdf.Ln(1)

	pdf.SetX(boxX)
	pdf.SetFont("Helvetica", "B", 12)
	pdf.SetTextColor(17, 24, 39)
	pdf.CellFormat(labelW, 9, "Total due", "", 0, "L", false, 0, "")
	pdf.CellFormat(valueW, 9, fmtPDFMoney(d.TotalCents, d.Currency), "", 1, "R", false, 0, "")

	// "locked at approval" note — the total came from the frozen timesheet amount
	if d.Locked {
		pdf.SetX(boxX)
		pdf.SetFont("Helvetica", "I", 7)
		pdf.SetTextColor(22, 163, 74) // green-600
		pdf.CellFormat(boxW, 4, "Locked at approval", "", 1, "R", false, 0, "")
	}

	// ── footer ───────────────────────────────────────────────────────────────
	// Disable auto page-break so the bottom-anchored footer doesn't spill onto a
	// second blank page.
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetY(-16)
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetTextColor(156, 163, 175)
	footer := "Generated " + d.GeneratedAt.Format("2006-01-02 15:04 MST") + "  -  amounts in " + d.Currency
	pdf.CellFormat(0, 5, footer, "", 0, "C", false, 0, "")

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func drawRule(pdf *fpdf.Fpdf, marginL, marginR float64) {
	pdf.SetLineWidth(0.2)
	pdf.SetDrawColor(229, 231, 235) // gray-200
	y := pdf.GetY()
	pdf.Line(marginL, y, 210-marginR, y)
}

// fmtPDFHours mirrors the web formatHours: one decimal under 10h, whole above.
func fmtPDFHours(seconds int) string {
	h := float64(seconds) / 3600.0
	if h >= 10 {
		return strconv.Itoa(int(h+0.5)) + "h"
	}
	return strconv.FormatFloat(h, 'f', 1, 64) + "h"
}

// fmtPDFMoney formats integer cents as "<CODE> 1,234.56". Core PDF fonts can't
// render many currency glyphs (e.g. the rupee sign), so the ISO code is used.
func fmtPDFMoney(cents int64, currency string) string {
	neg := cents < 0
	if neg {
		cents = -cents
	}
	whole := cents / 100
	frac := cents % 100
	s := groupThousands(whole) + "." + pad2(frac)
	if neg {
		s = "-" + s
	}
	if currency != "" {
		return currency + " " + s
	}
	return s
}

func groupThousands(n int64) string {
	digits := strconv.FormatInt(n, 10)
	if len(digits) <= 3 {
		return digits
	}
	var b strings.Builder
	pre := len(digits) % 3
	if pre > 0 {
		b.WriteString(digits[:pre])
		if len(digits) > pre {
			b.WriteByte(',')
		}
	}
	for i := pre; i < len(digits); i += 3 {
		b.WriteString(digits[i : i+3])
		if i+3 < len(digits) {
			b.WriteByte(',')
		}
	}
	return b.String()
}

func pad2(n int64) string {
	if n < 10 {
		return "0" + strconv.FormatInt(n, 10)
	}
	return strconv.FormatInt(n, 10)
}

func fmtPDFDate(iso string) string {
	// iso is YYYY-MM-DD; render as "Jan 2, 2006".
	if len(iso) != 10 {
		return iso
	}
	months := []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}
	y := iso[0:4]
	m, _ := strconv.Atoi(iso[5:7])
	day, _ := strconv.Atoi(iso[8:10])
	if m < 1 || m > 12 {
		return iso
	}
	return months[m-1] + " " + strconv.Itoa(day) + ", " + y
}

func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-3]) + "..."
}
