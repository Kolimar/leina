package main

import "fmt"

type UserService struct {
	name string
}

func makeToken(user string) string {
	return user + "-token"
}

func (s *UserService) Login(user string) string {
	token := makeToken(user)
	return s.store(token)
}

func (s *UserService) store(token string) string {
	return token
}

func bootstrap() string {
	svc := &UserService{}
	return svc.Login("alice")
}

func main() {
	fmt.Println(bootstrap())
}
