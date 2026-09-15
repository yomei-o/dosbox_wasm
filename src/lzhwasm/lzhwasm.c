/*
 * lzh.wasm - LZH (LHA) reader for the browser, wrapping lhasa.
 *
 * Every archive this project touches - the JW_CAD distribution we ship
 * untouched, and the FEP archives the user drops in - is .lzh, and one of them
 * uses -lh1- (adaptive Huffman). Rather than reimplement those decoders in JS,
 * compile the real library.
 *
 * The whole archive is handed over as one buffer and comes back as one blob so
 * that JS only has to do two allocations:
 *
 *   u32 count
 *   count * { u32 name_off, u32 name_len, u32 data_off, u32 data_len, u32 is_dir }
 *   name bytes (Shift_JIS as stored in the archive)
 *   file bytes
 *
 * Offsets are relative to the start of the blob.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "lha_reader.h"
#include "lha_input_stream.h"
#include "lha_file_header.h"

#include <emscripten.h>

typedef struct {
	const uint8_t *data;
	size_t len;
	size_t pos;
} MemStream;

static int mem_read(void *handle, void *buf, size_t buf_len)
{
	MemStream *s = handle;
	size_t avail = s->len - s->pos;
	if (avail == 0) {
		return 0;
	}
	if (buf_len > avail) {
		buf_len = avail;
	}
	memcpy(buf, s->data + s->pos, buf_len);
	s->pos += buf_len;
	return (int) buf_len;
}

static int mem_skip(void *handle, size_t bytes)
{
	MemStream *s = handle;
	if (bytes > s->len - s->pos) {
		return 0;
	}
	s->pos += bytes;
	return 1;
}

static void mem_close(void *handle)
{
	(void) handle;
}

static const LHAInputStreamType mem_stream_type = {
	mem_read, mem_skip, mem_close
};

/* A growable byte buffer; the blob is built in two passes over one array. */
typedef struct {
	uint8_t *p;
	size_t len;
	size_t cap;
} Buf;

static int buf_add(Buf *b, const void *data, size_t n)
{
	if (b->len + n > b->cap) {
		size_t cap = b->cap ? b->cap : 4096;
		while (cap < b->len + n) {
			cap *= 2;
		}
		uint8_t *np = realloc(b->p, cap);
		if (np == NULL) {
			return 0;
		}
		b->p = np;
		b->cap = cap;
	}
	if (data != NULL) {
		memcpy(b->p + b->len, data, n);
	} else {
		memset(b->p + b->len, 0, n);
	}
	b->len += n;
	return 1;
}

#define MAX_ENTRIES 4096

typedef struct {
	uint32_t name_off, name_len, data_off, data_len, is_dir;
} Entry;

EMSCRIPTEN_KEEPALIVE
uint8_t *lzh_extract(const uint8_t *in, uint32_t in_len, uint32_t *out_len)
{
	MemStream ms = { in, in_len, 0 };
	Entry *entries = NULL;
	Buf names = { 0 }, files = { 0 }, blob = { 0 };
	unsigned int count = 0;
	uint8_t *result = NULL;

	LHAInputStream *stream = lha_input_stream_new(&mem_stream_type, &ms);
	if (stream == NULL) {
		return NULL;
	}
	LHAReader *reader = lha_reader_new(stream);
	if (reader == NULL) {
		lha_input_stream_free(stream);
		return NULL;
	}

	entries = calloc(MAX_ENTRIES, sizeof(Entry));
	if (entries == NULL) {
		goto done;
	}

	LHAFileHeader *hdr;
	while ((hdr = lha_reader_next_file(reader)) != NULL && count < MAX_ENTRIES) {
		/* Rebuild "dir/name" the way the archive stored it. */
		char name[1024];
		name[0] = '\0';
		if (hdr->path != NULL) {
			strncpy(name, hdr->path, sizeof(name) - 1);
			name[sizeof(name) - 1] = '\0';
		}
		if (hdr->filename != NULL) {
			size_t used = strlen(name);
			strncpy(name + used, hdr->filename, sizeof(name) - used - 1);
			name[sizeof(name) - 1] = '\0';
		}

		Entry *e = &entries[count];
		e->name_off = (uint32_t) names.len;
		e->name_len = (uint32_t) strlen(name);
		e->is_dir = hdr->filename == NULL;
		if (!buf_add(&names, name, e->name_len)) {
			goto done;
		}

		e->data_off = (uint32_t) files.len;
		if (!e->is_dir) {
			uint8_t chunk[16384];
			size_t n;
			while ((n = lha_reader_read(reader, chunk, sizeof(chunk))) > 0) {
				if (!buf_add(&files, chunk, n)) {
					goto done;
				}
			}
		}
		e->data_len = (uint32_t) (files.len - e->data_off);
		count++;
	}

	/* Assemble: header, index, names, data. */
	uint32_t index_bytes = count * (uint32_t) sizeof(Entry);
	uint32_t names_base = 4 + index_bytes;
	uint32_t files_base = names_base + (uint32_t) names.len;

	uint32_t c32 = count;
	if (!buf_add(&blob, &c32, 4)) {
		goto done;
	}
	for (unsigned int i = 0; i < count; i++) {
		Entry e = entries[i];
		e.name_off += names_base;
		e.data_off += files_base;
		if (!buf_add(&blob, &e, sizeof(e))) {
			goto done;
		}
	}
	if (!buf_add(&blob, names.p, names.len)) {
		goto done;
	}
	if (!buf_add(&blob, files.p, files.len)) {
		goto done;
	}

	result = blob.p;
	*out_len = (uint32_t) blob.len;
	blob.p = NULL;

done:
	free(entries);
	free(names.p);
	free(files.p);
	free(blob.p);
	lha_reader_free(reader);
	lha_input_stream_free(stream);
	return result;
}

EMSCRIPTEN_KEEPALIVE
void lzh_free(uint8_t *p)
{
	free(p);
}

EMSCRIPTEN_KEEPALIVE
uint8_t *lzh_alloc(uint32_t n)
{
	return malloc(n);
}
