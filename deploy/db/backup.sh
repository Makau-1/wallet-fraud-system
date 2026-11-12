#!/bin/sh
# Writes a backup of the database to /tmp/backup.sql inside the db container.
#   docker compose exec db sh /dbtools/backup.sh
#   docker compose cp db:/tmp/backup.sql backup.sql
set -e
mysqldump -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" --no-tablespaces "$MYSQL_DATABASE" > /tmp/backup.sql
echo "Backup written to /tmp/backup.sql"
