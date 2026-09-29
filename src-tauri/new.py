print("=== User Information Form ===")

name = input("Enter your name: ")
age = int(input("Enter your age: "))
email = input("Enter your email: ")
country = input("Enter your country: ")

print("\n=== Your Information ===")
print(f"Name: {name}")
print(f"Age: {age}")
print(f"Email: {email}")
print(f"Country: {country}")

if age >= 18:
    print("Status: Adult")
else:
    print("Status: Minor")

print("\nThank you for using the program!")