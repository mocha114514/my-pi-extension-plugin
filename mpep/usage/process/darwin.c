#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    char *end = NULL;
    long value = strtol(argv[1], &end, 10);
    if (!end || *end || value <= 0 || value > 2147483647) return 2;
    struct proc_bsdinfo info = {0};
    int count = proc_pidinfo((int)value, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (count != sizeof(info)) {
        puts(errno == ESRCH ? "gone" : "unknown");
        return 0;
    }
    printf("%llu:%llu\n", (unsigned long long)info.pbi_start_tvsec,
           (unsigned long long)info.pbi_start_tvusec);
    return 0;
}
