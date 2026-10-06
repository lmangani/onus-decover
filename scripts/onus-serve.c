/* Local static server for the macOS app bundle. Binds to 127.0.0.1 only. */
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static char root_real[PATH_MAX];

static int send_all(int fd, const void *data, size_t length) {
  const char *bytes = data;
  size_t sent = 0;
  while (sent < length) {
    ssize_t count = send(fd, bytes + sent, length - sent, 0);
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    sent += (size_t)count;
  }
  return 0;
}

static const char *mime_of(const char *path) {
  const char *dot = strrchr(path, '.');
  if (!dot) return "application/octet-stream";
  if (strcmp(dot, ".html") == 0) return "text/html; charset=utf-8";
  if (strcmp(dot, ".js") == 0 || strcmp(dot, ".mjs") == 0) return "text/javascript; charset=utf-8";
  if (strcmp(dot, ".css") == 0) return "text/css; charset=utf-8";
  if (strcmp(dot, ".wasm") == 0) return "application/wasm";
  if (strcmp(dot, ".json") == 0 || strcmp(dot, ".map") == 0) return "application/json";
  if (strcmp(dot, ".svg") == 0) return "image/svg+xml";
  if (strcmp(dot, ".png") == 0) return "image/png";
  if (strcmp(dot, ".ico") == 0) return "image/x-icon";
  if (strcmp(dot, ".txt") == 0) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

static void url_decode(char *text) {
  char *read = text;
  char *write = text;
  while (*read) {
    if (read[0] == '%' && isxdigit((unsigned char)read[1]) && isxdigit((unsigned char)read[2])) {
      char hex[3] = {read[1], read[2], 0};
      *write++ = (char)strtol(hex, NULL, 16);
      read += 3;
    } else {
      *write++ = *read++;
    }
  }
  *write = 0;
}

static int has_dotdot(const char *path) {
  const char *mark = path;
  while ((mark = strstr(mark, "..")) != NULL) {
    char before = mark == path ? '/' : mark[-1];
    char after = mark[2];
    if (before == '/' && (after == '/' || after == '\0')) return 1;
    mark += 2;
  }
  return 0;
}

static int inside_root(const char *resolved) {
  size_t length = strlen(root_real);
  if (strncmp(resolved, root_real, length) != 0) return 0;
  return resolved[length] == '\0' || resolved[length] == '/';
}

static void respond(int client, const char *status, const char *mime, const char *body, int include_body) {
  char header[768];
  size_t length = body ? strlen(body) : 0;
  int count = snprintf(
      header,
      sizeof header,
      "HTTP/1.1 %s\r\n"
      "Content-Type: %s\r\n"
      "Content-Length: %zu\r\n"
      "Cross-Origin-Opener-Policy: same-origin\r\n"
      "Cross-Origin-Embedder-Policy: require-corp\r\n"
      "Cross-Origin-Resource-Policy: same-origin\r\n"
      "Cache-Control: no-cache\r\n"
      "Connection: close\r\n"
      "\r\n",
      status,
      mime,
      length);
  if (count < 0) return;
  send_all(client, header, (size_t)count);
  if (include_body && body) send_all(client, body, length);
}

static void send_file(int client, const char *path, int include_body) {
  FILE *file = fopen(path, "rb");
  if (!file) {
    respond(client, "404 Not Found", "text/plain; charset=utf-8", "Not found\n", include_body);
    return;
  }
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    respond(client, "500 Internal Server Error", "text/plain; charset=utf-8", "Unreadable\n", include_body);
    return;
  }
  long size = ftell(file);
  if (size < 0) {
    fclose(file);
    respond(client, "500 Internal Server Error", "text/plain; charset=utf-8", "Unreadable\n", include_body);
    return;
  }
  rewind(file);
  char header[768];
  int count = snprintf(
      header,
      sizeof header,
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: %s\r\n"
      "Content-Length: %ld\r\n"
      "Cross-Origin-Opener-Policy: same-origin\r\n"
      "Cross-Origin-Embedder-Policy: require-corp\r\n"
      "Cross-Origin-Resource-Policy: same-origin\r\n"
      "Cache-Control: no-cache\r\n"
      "Connection: close\r\n"
      "\r\n",
      mime_of(path),
      size);
  if (count > 0) send_all(client, header, (size_t)count);
  if (include_body) {
    char buffer[65536];
    size_t read = 0;
    while ((read = fread(buffer, 1, sizeof buffer, file)) > 0) {
      if (send_all(client, buffer, read) != 0) break;
    }
  }
  fclose(file);
}

static void handle(int client, const char *request) {
  char method[8];
  char target[2048];
  if (sscanf(request, "%7s %2047s", method, target) != 2) {
    respond(client, "400 Bad Request", "text/plain; charset=utf-8", "Bad request\n", 1);
    return;
  }
  int include_body = strcmp(method, "HEAD") != 0;
  if (strcmp(method, "GET") != 0 && strcmp(method, "HEAD") != 0) {
    respond(client, "405 Method Not Allowed", "text/plain; charset=utf-8", "Method not allowed\n", 1);
    return;
  }
  char *query = strchr(target, '?');
  if (query) *query = 0;
  url_decode(target);
  if (target[0] != '/' || has_dotdot(target)) {
    respond(client, "403 Forbidden", "text/plain; charset=utf-8", "Forbidden\n", include_body);
    return;
  }
  char full[PATH_MAX];
  const char *relative = strcmp(target, "/") == 0 ? "/index.html" : target;
  if (snprintf(full, sizeof full, "%s%s", root_real, relative) >= (int)sizeof full) {
    respond(client, "414 URI Too Long", "text/plain; charset=utf-8", "Path too long\n", include_body);
    return;
  }
  char resolved[PATH_MAX];
  struct stat info;
  if (stat(full, &info) == 0 && S_ISDIR(info.st_mode)) {
    size_t used = strlen(full);
    if (used + 12 >= sizeof full) {
      respond(client, "414 URI Too Long", "text/plain; charset=utf-8", "Path too long\n", include_body);
      return;
    }
    if (full[used - 1] != '/') strcat(full, "/");
    strcat(full, "index.html");
  }
  if (!realpath(full, resolved) || !inside_root(resolved)) {
    respond(client, "404 Not Found", "text/plain; charset=utf-8", "Not found\n", include_body);
    return;
  }
  send_file(client, resolved, include_body);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: onus-serve <directory> [port]\n");
    return 1;
  }
  if (!realpath(argv[1], root_real)) {
    perror(argv[1]);
    return 1;
  }
  int port = argc >= 3 ? atoi(argv[2]) : 4173;
  if (port < 1 || port > 65535) port = 4173;

  int server = socket(AF_INET, SOCK_STREAM, 0);
  if (server < 0) {
    perror("socket");
    return 1;
  }
  int yes = 1;
  setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)port);
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
  if (bind(server, (struct sockaddr *)&address, sizeof address) != 0) {
    perror("bind");
    close(server);
    return 2;
  }
  if (listen(server, 16) != 0) {
    perror("listen");
    close(server);
    return 1;
  }
  printf("LISTENING %d\n", port);
  fflush(stdout);

  for (;;) {
    int client = accept(server, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR) continue;
      perror("accept");
      break;
    }
    char request[8192];
    size_t used = 0;
    while (used + 1 < sizeof request) {
      ssize_t count = recv(client, request + used, sizeof request - 1 - used, 0);
      if (count <= 0) break;
      used += (size_t)count;
      request[used] = 0;
      if (strstr(request, "\r\n\r\n")) break;
    }
    request[used] = 0;
    if (used > 0) handle(client, request);
    close(client);
  }
  close(server);
  return 0;
}
