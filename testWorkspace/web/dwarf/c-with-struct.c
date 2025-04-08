
// Compile with:
// clang -O0 -g -fdebug-compilation-dir=. --target=wasm32-unknown-unknown -nostdlib c-with-struct.c -o c-with-struct.wasm
typedef struct data_t {
    char id[12];
    int x;
    int y;
} data_t;

int process(void *data) {
    return 0; // Break here and evaluate (data_t*)data in the repl interface
}

int _start() {
    data_t data = { .id = "Hello world", .x = 12, .y = 34 };
    return process(&data);
}