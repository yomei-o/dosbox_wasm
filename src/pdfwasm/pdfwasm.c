/* A thin front to libharu, for turning a JW_CAD plot into a PDF.
 *
 * The page already parses the plot stream (web/plot.js) into lines, arcs,
 * points and text, so this only has to put those on a page. Everything is in
 * millimetres and degrees, the units the plot arrives in; PDF works in points,
 * and the conversion happens here rather than in three places in JavaScript.
 *
 * Japanese text needs no embedded font. PDF has standard CJK encodings, and
 * 90ms-RKSJ-H takes Shift-JIS bytes exactly as the plot delivers them, so the
 * text in the PDF stays real text - selectable and searchable - without
 * carrying a 10MB font along.
 */

#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <setjmp.h>
#include <emscripten.h>
#include "hpdf.h"

#define MM_TO_PT (72.0f / 25.4f)

static HPDF_Doc doc;
static HPDF_Page page;
static HPDF_Font jp_font;
static unsigned char *out_buf;
static unsigned int out_len;
static jmp_buf env;

static void error_handler(HPDF_STATUS error_no, HPDF_STATUS detail_no, void *user_data)
{
    (void)detail_no;
    (void)user_data;
    (void)error_no;
    longjmp(env, 1);
}

static void release(void)
{
    if (doc) { HPDF_Free(doc); doc = NULL; }
    page = NULL;
    jp_font = NULL;
}

/* Start a page of the given size. Returns 0 on success. */
EMSCRIPTEN_KEEPALIVE
int pdf_begin(double width_mm, double height_mm)
{
    release();
    free(out_buf);
    out_buf = NULL;
    out_len = 0;

    if (setjmp(env)) { release(); return -1; }

    doc = HPDF_New(error_handler, NULL);
    if (!doc) return -1;

    /* The standard Japanese encodings and the fonts that go with them. The
     * font itself is not embedded; a reader supplies it. */
    HPDF_UseJPEncodings(doc);
    HPDF_UseJPFonts(doc);
    jp_font = HPDF_GetFont(doc, "MS-Gothic", "90ms-RKSJ-H");

    page = HPDF_AddPage(doc);
    HPDF_Page_SetWidth(page, (HPDF_REAL)(width_mm * MM_TO_PT));
    HPDF_Page_SetHeight(page, (HPDF_REAL)(height_mm * MM_TO_PT));
    HPDF_Page_SetLineCap(page, HPDF_ROUND_END);
    HPDF_Page_SetLineJoin(page, HPDF_ROUND_JOIN);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void pdf_color(int r, int g, int b)
{
    if (!page) return;
    if (setjmp(env)) return;
    HPDF_Page_SetRGBStroke(page, r / 255.0f, g / 255.0f, b / 255.0f);
    HPDF_Page_SetRGBFill(page, r / 255.0f, g / 255.0f, b / 255.0f);
}

EMSCRIPTEN_KEEPALIVE
void pdf_width(double mm)
{
    if (!page) return;
    if (setjmp(env)) return;
    HPDF_Page_SetLineWidth(page, (HPDF_REAL)(mm * MM_TO_PT));
}

/* A dash of on/off millimetres; both zero means a solid line. */
EMSCRIPTEN_KEEPALIVE
void pdf_dash(double on_mm, double off_mm)
{
    if (!page) return;
    if (setjmp(env)) return;
    if (on_mm <= 0 || off_mm <= 0) {
        HPDF_Page_SetDash(page, NULL, 0, 0);
    } else {
        HPDF_REAL pattern[2];
        pattern[0] = (HPDF_REAL)(on_mm * MM_TO_PT);
        pattern[1] = (HPDF_REAL)(off_mm * MM_TO_PT);
        HPDF_Page_SetDash(page, pattern, 2, 0);
    }
}

EMSCRIPTEN_KEEPALIVE
void pdf_move(double x_mm, double y_mm)
{
    if (!page) return;
    if (setjmp(env)) return;
    HPDF_Page_MoveTo(page, (HPDF_REAL)(x_mm * MM_TO_PT), (HPDF_REAL)(y_mm * MM_TO_PT));
}

EMSCRIPTEN_KEEPALIVE
void pdf_line(double x_mm, double y_mm)
{
    if (!page) return;
    if (setjmp(env)) return;
    HPDF_Page_LineTo(page, (HPDF_REAL)(x_mm * MM_TO_PT), (HPDF_REAL)(y_mm * MM_TO_PT));
}

EMSCRIPTEN_KEEPALIVE
void pdf_stroke(void)
{
    if (!page) return;
    if (setjmp(env)) return;
    HPDF_Page_Stroke(page);
}

/* Angles in degrees, anticlockwise from the x axis - the plot's convention.
 * libharu measures its arcs clockwise from north, so convert. */
EMSCRIPTEN_KEEPALIVE
void pdf_arc(double cx_mm, double cy_mm, double r_mm, double a1_deg, double a2_deg)
{
    if (!page) return;
    if (setjmp(env)) return;
    if (fabs(a2_deg - a1_deg) >= 359.9) {
        HPDF_Page_Circle(page, (HPDF_REAL)(cx_mm * MM_TO_PT), (HPDF_REAL)(cy_mm * MM_TO_PT),
                         (HPDF_REAL)(r_mm * MM_TO_PT));
    } else {
        HPDF_Page_Arc(page, (HPDF_REAL)(cx_mm * MM_TO_PT), (HPDF_REAL)(cy_mm * MM_TO_PT),
                      (HPDF_REAL)(r_mm * MM_TO_PT),
                      (HPDF_REAL)(90.0 - a2_deg), (HPDF_REAL)(90.0 - a1_deg));
    }
    HPDF_Page_Stroke(page);
}

EMSCRIPTEN_KEEPALIVE
void pdf_dot(double x_mm, double y_mm, double r_mm)
{
    if (!page) return;
    if (setjmp(env)) return;
    HPDF_Page_Circle(page, (HPDF_REAL)(x_mm * MM_TO_PT), (HPDF_REAL)(y_mm * MM_TO_PT),
                     (HPDF_REAL)(r_mm * MM_TO_PT));
    HPDF_Page_Fill(page);
}

/* text is Shift-JIS, exactly as the plot stream carries it. */
EMSCRIPTEN_KEEPALIVE
void pdf_text(double x_mm, double y_mm, double size_mm, double angle_deg, const char *text)
{
    if (!page || !jp_font || !text || !*text) return;
    if (setjmp(env)) { HPDF_Page_EndText(page); return; }

    HPDF_Page_SetFontAndSize(page, jp_font, (HPDF_REAL)(size_mm * MM_TO_PT));
    HPDF_Page_BeginText(page);
    if (angle_deg != 0.0) {
        const double rad = angle_deg * 3.14159265358979323846 / 180.0;
        const HPDF_REAL c = (HPDF_REAL)cos(rad), s = (HPDF_REAL)sin(rad);
        HPDF_Page_SetTextMatrix(page, c, s, -s, c,
                                (HPDF_REAL)(x_mm * MM_TO_PT), (HPDF_REAL)(y_mm * MM_TO_PT));
    } else {
        HPDF_Page_MoveTextPos(page, (HPDF_REAL)(x_mm * MM_TO_PT), (HPDF_REAL)(y_mm * MM_TO_PT));
    }
    HPDF_Page_ShowText(page, text);
    HPDF_Page_EndText(page);
}

/* Finish the document. Returns its length in bytes, or -1. */
EMSCRIPTEN_KEEPALIVE
int pdf_end(void)
{
    if (!doc) return -1;
    if (setjmp(env)) { release(); return -1; }

    HPDF_SaveToStream(doc);
    const HPDF_UINT32 size = HPDF_GetStreamSize(doc);
    if (!size) { release(); return -1; }

    out_buf = malloc(size);
    if (!out_buf) { release(); return -1; }

    out_len = size;
    HPDF_ResetStream(doc);
    HPDF_UINT32 got = size;
    HPDF_ReadFromStream(doc, out_buf, &got);
    out_len = got;
    release();
    return (int)out_len;
}

EMSCRIPTEN_KEEPALIVE
const unsigned char *pdf_data(void) { return out_buf; }

EMSCRIPTEN_KEEPALIVE
void pdf_release(void)
{
    release();
    free(out_buf);
    out_buf = NULL;
    out_len = 0;
}
