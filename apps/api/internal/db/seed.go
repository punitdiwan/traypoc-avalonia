package db

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type SeedUser struct {
	Email    string
	Password string
	Role     string
	CanTrack bool
}

func seedUsers() []SeedUser {
	get := func(key, fallback string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return fallback
	}
	return []SeedUser{
		{
			Email:    get("SEED_EMPLOYER_EMAIL", "admin@example.com"),
			Password: get("SEED_EMPLOYER_PASSWORD", "Admin1234!"),
			Role:     "employer",
			CanTrack: false,
		},
		{
			Email:    get("SEED_EMPLOYEE_EMAIL", "employee@example.com"),
			Password: get("SEED_EMPLOYEE_PASSWORD", "Employee1234!"),
			Role:     "employee",
			CanTrack: true,
		},
	}
}

// Seed inserts the default employer and employee accounts if they do not
// already exist. It is safe to call on every startup — existing rows are
// skipped via ON CONFLICT DO NOTHING.
func Seed(ctx context.Context, pool *pgxpool.Pool) error {
	users := seedUsers()

	for _, u := range users {
		hash, err := bcrypt.GenerateFromPassword([]byte(u.Password), bcrypt.DefaultCost)
		if err != nil {
			return fmt.Errorf("hash password for %s: %w", u.Email, err)
		}

		tag, err := pool.Exec(ctx,
			`INSERT INTO users (email, password_hash, role, can_track)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (email) DO NOTHING`,
			u.Email, string(hash), u.Role, u.CanTrack,
		)
		if err != nil {
			return fmt.Errorf("seed user %s: %w", u.Email, err)
		}

		if tag.RowsAffected() > 0 {
			log.Printf("[seed] created %s (%s) can_track=%v  password=%s",
				u.Email, u.Role, u.CanTrack, u.Password)
		} else {
			log.Printf("[seed] skipped %s — already exists", u.Email)
		}
	}

	return nil
}
