# The nightly backup: the database dump and the files, kept on the office server and, encrypted, in the cloud.
FROM postgres:16
RUN apt-get update && apt-get install -y --no-install-recommends rclone jq ca-certificates && rm -rf /var/lib/apt/lists/*
COPY backup.sh run.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/run.sh /usr/local/bin/restore.sh
ENTRYPOINT ["/usr/local/bin/run.sh"]
