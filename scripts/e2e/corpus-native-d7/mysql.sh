#!/bin/bash
# starts MariaDB on a data directory inside /out, so the install and the verify step share one database
set -euo pipefail
DATA=/out/mysql
if [ ! -d "$DATA/mysql" ]; then
	mkdir -p "$DATA"
	chown -R mysql:mysql "$DATA"
	mysql_install_db --user=mysql --datadir="$DATA" --skip-test-db > /out/mysql-init.log 2>&1
fi
mysqld_safe --user=mysql --datadir="$DATA" --bind-address=127.0.0.1 --max_allowed_packet=64M \
	--skip-grant-tables=0 > /out/mysqld.log 2>&1 &
for i in $(seq 1 90); do
	mysqladmin ping --silent 2> /dev/null && break
	sleep 1
done
mysql -e "CREATE DATABASE IF NOT EXISTS d7 CHARACTER SET utf8mb4"
mysql -e "CREATE USER IF NOT EXISTS 'd7'@'%' IDENTIFIED BY 'd7'; GRANT ALL ON d7.* TO 'd7'@'%'"
